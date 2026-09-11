// data.json persistence — which settings the plugin is allowed to write.
//
// Config resolution is layered: code defaults ← <pluginDir>/config.yaml ←
// data.json. data.json is LAST, so it wins. Saving the whole merged settings
// object therefore froze every config.yaml value into data.json, and
// config.yaml was silently shadowed from the first settings save onward.
//
// Only the keys the Settings tab actually renders are written now. Every other
// knob stays in config.yaml, where its own documentation says it belongs.

/** Builds the data.json payload: the listed keys, and nothing else. */
export function settingsTabPayload<T extends object>(
  settings: T,
  persistedKeys: readonly (keyof T)[],
): Partial<T> {
  const payload: Record<string, unknown> = {};
  for (const key of persistedKeys) {
    payload[String(key)] = settings[key];
  }
  return payload as Partial<T>;
}
