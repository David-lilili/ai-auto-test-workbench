export interface AppDeviceConfig {
  platformName: string;
  automationName: string;
  deviceName: string;
  appPackage?: string;
  appActivity?: string;
  bundleId?: string;
}

export class AppDriver {
  async open(_device: AppDeviceConfig): Promise<void> {
    throw new Error("Appium driver is reserved for phase 2. Configure devices first.");
  }
}
