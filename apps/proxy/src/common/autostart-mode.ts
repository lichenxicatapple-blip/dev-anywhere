interface AutostartRegistration {
  status(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

/** Install the replacement first. Failure must not leave the user with no startup registration. */
export async function switchAutostartMode(
  selected: AutostartRegistration,
  previous: AutostartRegistration,
): Promise<void> {
  const alreadyEnabled = await selected.status();
  const previousEnabled = await previous.status();
  await selected.enable();
  try {
    await previous.disable();
  } catch (error) {
    // Disable can fail after changing OS state (for example when removing the old file fails).
    // Restore that mode before rolling back the replacement, so there is always a startup path.
    if (previousEnabled) await previous.enable();
    if (!alreadyEnabled) await selected.disable();
    throw error;
  }
}
