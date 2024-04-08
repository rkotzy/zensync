// These should all be optional for compatibility safety
export interface GlobalSettings {
  sameSenderTimeframe?: number;
}

export const GlobalSettingDefaults: GlobalSettings = {
  sameSenderTimeframe: 60 * 30 // 30 minutes
};
