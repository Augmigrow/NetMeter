// Windows uses relaunch metadata, not BrowserWindow.icon, when creating a pin.
export const APP_ID = 'local.netmeter.desktop';
export function shellIdentity(execPath, projectRoot, iconPath) {
  return {
    window: { appId: APP_ID, appIconPath: iconPath, appIconIndex: 0,
      relaunchCommand: '"' + execPath + '" "' + projectRoot + '"', relaunchDisplayName: 'NetMeter' },
    shortcut: { target: execPath, args: '"' + projectRoot + '"', cwd: projectRoot,
      description: 'NetMeter network traffic widget', icon: iconPath, iconIndex: 0, appUserModelId: APP_ID }
  };
}
