// Trusted-event tag namespace.
//
// `source` is descriptive metadata, never authority. Event claims are minted
// only by the private intake writer and validated against committed provenance.
// This helper normalizes Unicode compatibility forms and case before checking
// the `event:` namespace, so ordinary save/update callers cannot smuggle a
// claim with "Event:Self_Action" or full-width characters, including unknown
// future `event:*` tags.
export const TRUSTED_EVENT_KINDS = Object.freeze([
  "self_action", "direct_interaction", "reported_by_other", "observation"
]);

const EVENT_TAG_BY_KIND = Object.freeze({
  self_action: "event:self_action",
  direct_interaction: "event:direct_interaction",
  reported_by_other: "event:reported_by_other",
  observation: "event:observation"
});

export function eventTagForKind(kind) {
  return Object.hasOwn(EVENT_TAG_BY_KIND, kind) ? EVENT_TAG_BY_KIND[kind] : undefined;
}

/** Canonical event-tag form, or null when this is not an event:* claim. */
export function normalizeEventTag(tag) {
  if (typeof tag !== "string") return null;
  const normalized = tag.normalize("NFKC").trim().toLowerCase();
  return normalized.startsWith("event:") ? normalized : null;
}

/** True for any current or future event:* claim, regardless of spelling. */
export function isEventTag(tag) {
  return normalizeEventTag(tag) !== null;
}

/** Drop every event:* claim (case/Unicode normalized), preserving other tags. */
export function stripEventTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag) => !isEventTag(tag));
}
