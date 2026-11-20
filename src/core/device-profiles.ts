import { randomInt } from 'node:crypto';
import type { Account, Device } from './model.js';

type Profile = Omit<Device, 'androidId'>;

export const deviceProfiles = Object.freeze({
  // Xiaomi / Redmi
  xiaomi15: Object.freeze({ manufacturer: 'Xiaomi', model: '24129PN74C', androidRelease: '15', sdk: '35', buildId: 'AP3A.240905.015.A2', appVersion: '3.0.0' }),
  xiaomi14: Object.freeze({ manufacturer: 'Xiaomi', model: '23127PN0CC', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230804.001', appVersion: '3.0.0' }),
  xiaomi13: Object.freeze({ manufacturer: 'Xiaomi', model: '2211133C', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230804.001', appVersion: '3.0.0' }),
  redmiK70Ultra: Object.freeze({ manufacturer: 'Xiaomi', model: '2407FRK8EC', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  redmiK70: Object.freeze({ manufacturer: 'Xiaomi', model: '2311DRK48C', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230804.001', appVersion: '3.0.0' }),
  redmiTurbo3: Object.freeze({ manufacturer: 'Xiaomi', model: '24069RA21C', androidRelease: '14', sdk: '34', buildId: 'UKQ1.240116.001', appVersion: '3.0.0' }),
  xiaomi: Object.freeze({ manufacturer: 'Xiaomi', model: 'M2007J3SC', androidRelease: '11', sdk: '30', buildId: 'RKQ1.200826.002', appVersion: '3.0.0' }),
  redmiK40: Object.freeze({ manufacturer: 'Xiaomi', model: 'M2012K11AC', androidRelease: '13', sdk: '33', buildId: 'TKQ1.220829.002', appVersion: '3.0.0' }),
  redmiNote8: Object.freeze({ manufacturer: 'Xiaomi', model: 'Redmi Note 8', androidRelease: '11', sdk: '30', buildId: 'RKQ1.201004.002', appVersion: '3.0.0' }),

  // vivo / iQOO
  vivoX100: Object.freeze({ manufacturer: 'vivo', model: 'V2309A', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  vivoS19: Object.freeze({ manufacturer: 'vivo', model: 'V2364A', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  iqoo12: Object.freeze({ manufacturer: 'vivo', model: 'V2307A', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  iqooNeo9: Object.freeze({ manufacturer: 'vivo', model: 'V2338A', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),

  // OPPO / OnePlus / Realme
  oppoFindX7: Object.freeze({ manufacturer: 'OPPO', model: 'PHZ110', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  oneplus12: Object.freeze({ manufacturer: 'OnePlus', model: 'PJD110', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230924.001', appVersion: '3.0.0' }),
  oneplusAce3: Object.freeze({ manufacturer: 'OnePlus', model: 'PJE110', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230924.001', appVersion: '3.0.0' }),
  oneplus8T: Object.freeze({ manufacturer: 'OnePlus', model: 'KB2005', androidRelease: '13', sdk: '33', buildId: 'RKQ1.211119.001', appVersion: '3.0.0' }),
  oneplus9: Object.freeze({ manufacturer: 'OnePlus', model: 'LE2115', androidRelease: '13', sdk: '33', buildId: 'TP1A.220905.001', appVersion: '3.0.0' }),
  oneplus9Pro: Object.freeze({ manufacturer: 'OnePlus', model: 'LE2125', androidRelease: '13', sdk: '33', buildId: 'TP1A.220905.001', appVersion: '3.0.0' }),
  realmeGT5Pro: Object.freeze({ manufacturer: 'realme', model: 'RMX3888', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230924.001', appVersion: '3.0.0' }),

  // HONOR / HUAWEI
  honorMagic6: Object.freeze({ manufacturer: 'HONOR', model: 'BVL-AN00', androidRelease: '14', sdk: '34', buildId: 'HONORBVL-AN00', appVersion: '3.0.0' }),
  honor200: Object.freeze({ manufacturer: 'HONOR', model: 'ELI-AN00', androidRelease: '14', sdk: '34', buildId: 'HONORELI-AN00', appVersion: '3.0.0' }),
  huaweiMate60: Object.freeze({ manufacturer: 'HUAWEI', model: 'BRA-AL00', androidRelease: '12', sdk: '31', buildId: 'HUAWEIBRA-AL00', appVersion: '3.0.0' }),

  // Samsung / Meizu / Google
  samsungS24: Object.freeze({ manufacturer: 'samsung', model: 'SM-S9210', androidRelease: '14', sdk: '34', buildId: 'UP1A.231005.007', appVersion: '3.0.0' }),
  meizu21: Object.freeze({ manufacturer: 'meizu', model: 'M461Q', androidRelease: '14', sdk: '34', buildId: 'UKQ1.230917.001', appVersion: '3.0.0' }),
  pixel4: Object.freeze({ manufacturer: 'Google', model: 'Pixel 4', androidRelease: '11', sdk: '30', buildId: 'RQ3A.211001.001', appVersion: '3.0.0' }),
  pixel5: Object.freeze({ manufacturer: 'Google', model: 'Pixel 5', androidRelease: '11', sdk: '30', buildId: 'RQ3A.211005.001', appVersion: '3.0.0' }),
} satisfies Record<string, Profile>);

export type DevicePreset = keyof typeof deviceProfiles;

export const devicePresetNames: Readonly<Record<DevicePreset, string>> = Object.freeze({
  xiaomi15: '小米 15',
  xiaomi14: '小米 14',
  xiaomi13: '小米 13',
  redmiK70Ultra: 'Redmi K70 至尊版',
  redmiK70: 'Redmi K70',
  redmiTurbo3: 'Redmi Turbo 3',
  xiaomi: '小米 10 至尊版',
  redmiK40: 'Redmi K40',
  redmiNote8: 'Redmi Note 8',
  vivoX100: 'vivo X100',
  vivoS19: 'vivo S19',
  iqoo12: 'iQOO 12',
  iqooNeo9: 'iQOO Neo9',
  oppoFindX7: 'OPPO Find X7',
  oneplus12: '一加 12',
  oneplusAce3: '一加 Ace 3',
  oneplus8T: '一加 8T',
  oneplus9: '一加 9',
  oneplus9Pro: '一加 9 Pro',
  realmeGT5Pro: '真我 GT5 Pro',
  honorMagic6: '荣耀 Magic6',
  honor200: '荣耀 200',
  huaweiMate60: 'HUAWEI Mate 60',
  samsungS24: 'Galaxy S24',
  meizu21: '魅族 21',
  pixel4: 'Pixel 4',
  pixel5: 'Pixel 5',
});

export const devicePresetKeys = Object.freeze(Object.keys(deviceProfiles) as DevicePreset[]);

export function isDevicePreset(value: unknown): value is DevicePreset {
  return typeof value === 'string' && Object.hasOwn(deviceProfiles, value);
}

export function selectDeviceProfile(accounts: readonly Account[]): DevicePreset {
  const uses = devicePresetKeys.map(key =>
    accounts.filter(a => a.device.manufacturer === deviceProfiles[key].manufacturer && a.device.model === deviceProfiles[key].model).length,
  );
  const least = Math.min(...uses);
  const choices = devicePresetKeys.filter((_, i) => uses[i] === least);
  return choices[randomInt(choices.length)]!;
}

export function deviceFromPreset(key: DevicePreset, androidId: string): Device {
  if (!isDevicePreset(key)) throw new Error('Unknown device preset');
  return { ...deviceProfiles[key], androidId };
}
