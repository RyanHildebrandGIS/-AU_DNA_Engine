import { useAppStore } from "@geolibre/core";
import { useEffect, useRef } from "react";
import { DesktopShell } from "./components/layout/DesktopShell";
import { OnboardingDialog } from "./components/layout/OnboardingDialog";
import { UpdateNotificationModal } from "./components/layout/UpdateNotificationModal";
import { useDesktopSettingsPersistence } from "./hooks/useDesktopSettings";
import { useLayoutOptions } from "./hooks/useLayoutOptions";
import { useProjectUrlLoader } from "./hooks/useProjectUrlLoader";
import { useBeforeUnloadGuard } from "./hooks/useBeforeUnloadGuard";
import { useRecentProjectsPersistence } from "./hooks/useRecentProjectsPersistence";
import { useRuntimeEnvironmentVariables } from "./hooks/useRuntimeEnvironmentVariables";
import { useStartupUpdateCheck } from "./hooks/useStartupUpdateCheck";
import { useThemeMode } from "./hooks/useThemeMode";
import { useThemeScheme } from "./hooks/useThemeScheme";
import { useUiProfileBootstrap } from "./hooks/useUiProfileBootstrap";
import { useUndoRedoShortcuts } from "./hooks/useUndoRedoShortcuts";

export default function App() {
  const layoutOptions = useLayoutOptions();
  const { themeMode, toggleThemeMode } = useThemeMode();
  const projectUrlLoadState = useProjectUrlLoader();
  const { showOnboarding, dismissOnboarding, adminChecked } =
    useUiProfileBootstrap();
  const {
    pending: pendingUpdate,
    remindLater,
    skipVersion,
  } = useStartupUpdateCheck();

  useDesktopSettingsPersistence();
  useThemeScheme();
  useRecentProjectsPersistence();
  useRuntimeEnvironmentVariables();
  useUndoRedoShortcuts();
  useBeforeUnloadGuard();

  // Land on the Design nav destination on startup, once — but only after the
  // one-time onboarding wizard (if any) has resolved, so the two dialogs
  // never fight for the topmost z-index on a fresh profile.
  const setActiveView = useAppStore((s) => s.setActiveView);
  const hasAutoOpenedUtilityDesign = useRef(false);
  useEffect(() => {
    if (hasAutoOpenedUtilityDesign.current) return;
    if (!adminChecked || showOnboarding) return;
    hasAutoOpenedUtilityDesign.current = true;
    setActiveView("design");
  }, [adminChecked, showOnboarding, setActiveView]);
  return (
    <>
      <DesktopShell
        layoutOptions={layoutOptions}
        projectUrlLoadState={projectUrlLoadState}
        themeMode={themeMode}
        onToggleThemeMode={toggleThemeMode}
      />
      <OnboardingDialog open={showOnboarding} onClose={dismissOnboarding} />
      <UpdateNotificationModal
        pending={pendingUpdate}
        onRemindLater={remindLater}
        onSkipVersion={skipVersion}
      />
    </>
  );
}
