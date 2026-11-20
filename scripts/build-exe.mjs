/**
 * Build a standalone single-file Windows executable (release/cgscaline.exe)
 * using Node.js native SEA (Single Executable Application) + Win32 PE resource APIs.
 * Zero extra npm packages required (no postject / rcedit / pkg).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'release');
const TMP_DIR = join(OUT_DIR, '.sea-tmp');
const OUT_EXE = join(OUT_DIR, 'cgscaline.exe');
const ICO_PATH = join(ROOT, 'assets', 'cgscaline.ico');
const SEA_FUSE_OFF = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0', 'ascii');
const SEA_FUSE_ON  = Buffer.from('NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:1', 'ascii');

if (process.platform !== 'win32') {
  throw new Error('build:exe targets Windows (win32) PE executables.');
}

const t0 = Date.now();
await rm(TMP_DIR, { recursive: true, force: true });
await mkdir(TMP_DIR, { recursive: true });

try {
  // 1. Bundle TypeScript + undici into a single standalone CommonJS file
  const bundlePath = join(TMP_DIR, 'sea-bundle.cjs');
  await build({
    entryPoints: [join(ROOT, 'src', 'cli.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    minify: true,
    define: {
      'import.meta.url': '"file:///sea/cgscaline.cjs"',
    },
  });

  // 2. Generate official Node SEA blob (with V8 bytecode cache + experimental warning silenced)
  const seaConfigPath = join(TMP_DIR, 'sea-config.json');
  const blobPath = join(TMP_DIR, 'sea-prep.blob');
  await writeFile(
    seaConfigPath,
    JSON.stringify(
      {
        main: bundlePath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        useCodeCache: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
    cwd: TMP_DIR,
    stdio: 'inherit',
  });

  // 3. Copy current node.exe -> release/cgscaline.exe
  await copyFile(process.execPath, OUT_EXE);

  // 4. Strip Authenticode signature + replace icon with cgscaline.ico + inject NODE_SEA_BLOB via Win32 APIs
  const psScriptPath = join(TMP_DIR, 'patch-pe.ps1');
  const psScript = `
param([string]$ExePath, [string]$BlobPath, [string]$IcoPath)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class PeSeaPatcher {
  public delegate bool EnumResNameProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, IntPtr lParam);
  public delegate bool EnumResLangProc(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, ushort wIDLanguage, IntPtr lParam);

  [DllImport("imagehlp.dll", SetLastError = true)]
  private static extern bool ImageEnumerateCertificates(IntPtr FileHandle, ushort TypeFilter, out uint CertificateCount, IntPtr Indices, uint IndexCount);

  [DllImport("imagehlp.dll", SetLastError = true)]
  private static extern bool ImageRemoveCertificate(IntPtr FileHandle, uint Index);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr LoadLibraryExW(string lpFileName, IntPtr hFile, uint dwFlags);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool FreeLibrary(IntPtr hModule);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool EnumResourceNamesW(IntPtr hModule, IntPtr lpszType, EnumResNameProc lpEnumFunc, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool EnumResourceLanguagesW(IntPtr hModule, IntPtr lpszType, IntPtr lpszName, EnumResLangProc lpEnumFunc, IntPtr lParam);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr BeginUpdateResourceW(string pFileName, bool bDeleteExistingResources);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "UpdateResourceW")]
  private static extern bool UpdateResourceInt(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "UpdateResourceW")]
  private static extern bool UpdateResourceStr(IntPtr hUpdate, IntPtr lpType, string lpName, ushort wLanguage, byte[] lpData, uint cbData);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool EndUpdateResourceW(IntPtr hUpdate, bool fDiscard);

  private struct OldRes {
    public int TypeId;
    public bool IsInt;
    public int IntId;
    public string StrName;
    public ushort Lang;
  }

  public static void StripCertificates(string exePath) {
    using (var fs = new FileStream(exePath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) {
      uint count = 0;
      if (ImageEnumerateCertificates(fs.SafeFileHandle.DangerousGetHandle(), 0x00ff, out count, IntPtr.Zero, 0) && count > 0) {
        for (int i = (int)count - 1; i >= 0; i--) {
          ImageRemoveCertificate(fs.SafeFileHandle.DangerousGetHandle(), (uint)i);
        }
      }
    }
  }

  public static void InjectResources(string exePath, byte[] seaBlob, byte[] icoBytes) {
    var toDelete = new List<OldRes>();
    IntPtr hMod = LoadLibraryExW(exePath, IntPtr.Zero, 0x00000022);
    if (hMod != IntPtr.Zero) {
      try {
        foreach (int tid in new int[] { 14, 3 }) {
          EnumResourceNamesW(hMod, (IntPtr)tid, (m, t, n, p) => {
            bool isInt = ((ulong)n.ToInt64() >> 16) == 0;
            int intId = isInt ? (int)n.ToInt64() : 0;
            string strName = isInt ? null : Marshal.PtrToStringUni(n);
            EnumResourceLanguagesW(m, t, n, (m2, t2, n2, lang, p2) => {
              toDelete.Add(new OldRes { TypeId = tid, IsInt = isInt, IntId = intId, StrName = strName, Lang = lang });
              return true;
            }, IntPtr.Zero);
            return true;
          }, IntPtr.Zero);
        }
      } finally {
        FreeLibrary(hMod);
      }
    }

    IntPtr hUpd = BeginUpdateResourceW(exePath, false);
    if (hUpd == IntPtr.Zero) throw new InvalidOperationException("BeginUpdateResourceW failed: " + Marshal.GetLastWin32Error());

    // Delete original node.exe icons
    foreach (var old in toDelete) {
      if (old.IsInt) UpdateResourceInt(hUpd, (IntPtr)old.TypeId, (IntPtr)old.IntId, old.Lang, null, 0);
      else UpdateResourceStr(hUpd, (IntPtr)old.TypeId, old.StrName, old.Lang, null, 0);
    }

    // Write custom cgscaline.ico (RT_ICON = 3, RT_GROUP_ICON = 14)
    if (icoBytes != null && icoBytes.Length >= 22) {
      ushort count = BitConverter.ToUInt16(icoBytes, 4);
      byte[] grp = new byte[6 + count * 14];
      Buffer.BlockCopy(icoBytes, 0, grp, 0, 6);
      for (int i = 0; i < count; i++) {
        int srcOff = 6 + i * 16;
        int dstOff = 6 + i * 14;
        uint imgSize = BitConverter.ToUInt32(icoBytes, srcOff + 8);
        uint imgOff  = BitConverter.ToUInt32(icoBytes, srcOff + 12);
        byte[] img = new byte[imgSize];
        Buffer.BlockCopy(icoBytes, (int)imgOff, img, 0, (int)imgSize);
        ushort iconId = (ushort)(i + 1);
        if (!UpdateResourceInt(hUpd, (IntPtr)3, (IntPtr)iconId, 1033, img, imgSize))
          throw new InvalidOperationException("UpdateResource RT_ICON failed: " + Marshal.GetLastWin32Error());
        Buffer.BlockCopy(icoBytes, srcOff, grp, dstOff, 12);
        byte[] idBytes = BitConverter.GetBytes(iconId);
        Buffer.BlockCopy(idBytes, 0, grp, dstOff + 12, 2);
      }
      if (!UpdateResourceInt(hUpd, (IntPtr)14, (IntPtr)1, 1033, grp, (uint)grp.Length))
        throw new InvalidOperationException("UpdateResource RT_GROUP_ICON failed: " + Marshal.GetLastWin32Error());
    }

    // Inject NODE_SEA_BLOB (RT_RCDATA = 10)
    if (!UpdateResourceStr(hUpd, (IntPtr)10, "NODE_SEA_BLOB", 1033, seaBlob, (uint)seaBlob.Length))
      throw new InvalidOperationException("UpdateResource NODE_SEA_BLOB failed: " + Marshal.GetLastWin32Error());

    if (!EndUpdateResourceW(hUpd, false))
      throw new InvalidOperationException("EndUpdateResourceW failed: " + Marshal.GetLastWin32Error());
  }
}
"@

[PeSeaPatcher]::StripCertificates($ExePath)
$blob = [System.IO.File]::ReadAllBytes($BlobPath)
$ico  = if (Test-Path $IcoPath) { [System.IO.File]::ReadAllBytes($IcoPath) } else { $null }
[PeSeaPatcher]::InjectResources($ExePath, $blob, $ico)
`;
  await writeFile(psScriptPath, psScript, 'utf8');
  const patchRes = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath, '-ExePath', OUT_EXE, '-BlobPath', blobPath, '-IcoPath', ICO_PATH],
    { encoding: 'utf8' },
  );
  if (patchRes.status !== 0) {
    throw new Error(`PE resource injection failed:\n${patchRes.stderr || patchRes.stdout}`);
  }

  // 5. Flip NODE_SEA_FUSE from :0 to :1
  const exeBuf = await readFile(OUT_EXE);
  let idx = exeBuf.indexOf(SEA_FUSE_OFF);
  if (idx < 0) {
    throw new Error('NODE_SEA_FUSE sentinel not found inside executable.');
  }
  while (idx >= 0) {
    SEA_FUSE_ON.copy(exeBuf, idx);
    idx = exeBuf.indexOf(SEA_FUSE_OFF, idx + SEA_FUSE_ON.length);
  }
  await writeFile(OUT_EXE, exeBuf);

  const info = await stat(OUT_EXE);
  const mb = (info.size / 1_048_576).toFixed(1);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nBuilt standalone executable: ${OUT_EXE} (${mb} MB, ${elapsed}s)`);
} finally {
  await rm(TMP_DIR, { recursive: true, force: true }).catch(() => {});
}
