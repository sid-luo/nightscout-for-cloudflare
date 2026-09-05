/** Realistic AAPS-shaped data with no user measurements or identifiers. */
export function syntheticDeviceStatus(identifier: string, date: number) {
  return {
    identifier, date, app: "AAPS", device: "openaps://synthetic-phone", utcOffset: 0,
    isCharging: false, configuration: {}, openaps: {}, uploaderBattery: 80,
    pump: {
      battery: { percent: 80 }, clock: new Date(date).toISOString(),
      extended: { nameValuePairs: {
        Version: "synthetic-test", LastBolus: "synthetic", LastBolusAmount: 0,
        BaseBasalRate: 0, ActiveProfile: "synthetic",
      } },
      reservoir: 50, status: { status: "synthetic", timestamp: new Date(date).toISOString() },
    },
  };
}
