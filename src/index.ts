// ============================================================
// Guest Home — external Sowel recipe (spec 002 of sowel-plugin-guestflow)
//
// guestFlow's guest app shows a « Domotique » page: room temperatures, the
// weather, the rain, the lodging's electricity, and the lights the owner
// entrusts to guests. A Sowel API token cannot be scoped, so guestFlow holds
// none: the `guestflow` plugin carries the traffic through its `home-bridge`
// device, and THIS recipe — the only part that reads equipments and sends
// orders — decides and acts.
//
// Nothing that decides also actuates. The plugin talks to the internet and
// holds no say over the house; this recipe holds the boundary in code:
//
//   • a command reaches only a LIGHT (light_onoff, light_dimmable, light_color,
//     or a switch carrying a light state), and only one the owner put in the
//     one setting, « Lumières confiées aux voyageurs »;
//   • only on/off, only if issued less than 60 s ago, at most 20 an hour per
//     LIGHT (the lodging is guestFlow's word, so it bounds nothing), each
//     command id once, never on the first read of the counter after a start,
//     never retried. No timer: the light stays as switched (gF rule 7).
//
// Worst case, accepted by Adrien on 2026-11-15 (gF rule 11): whoever fully
// controls guestFlow can switch each entrusted light 20 times an hour, and
// nothing else. Values leave the house only for the selected pairs that are in
// the catalogue — never another equipment's, never the bridge's; the catalogue
// describes sensors and lights by name and zone, never with a value.
// ============================================================

// ------------------------------------------------------------
// Types mirrored from Sowel core (src/shared/types.ts, src/recipes/engine/recipe.ts).
// Recipe packages never import the core; these are kept in sync by hand.
// ------------------------------------------------------------

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key" | "select";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    crossZone?: boolean;
  };
}

interface RecipeTileDef {
  icon?: string;
  summaryKey?: string;
}

interface DataBinding {
  alias: string;
  category?: string;
  value?: unknown;
  unit?: string;
  lastUpdated?: string | null;
}

interface ComputedData {
  alias: string;
  value: unknown;
  unit?: string;
  category?: string;
  lastUpdated: string | null;
}

interface OrderBinding {
  alias: string;
  type?: string;
  category?: string;
  enumValues?: string[];
}

interface Equipment {
  id: string;
  name?: string;
  type?: string;
  zoneId?: string;
}

export interface EquipmentDetails extends Equipment {
  dataBindings?: DataBinding[];
  orderBindings?: OrderBinding[];
  computedData?: ComputedData[];
}

interface Zone {
  id: string;
  name: string;
  parentId: string | null;
}

type Unsubscribe = () => void;

export interface RecipeContext {
  log(message: string, level?: "info" | "warn" | "error"): void;
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
  };
  eventBus: {
    onType(
      type: "equipment.data.changed",
      handler: (event: { equipmentId: string; alias: string; value: unknown }) => void,
    ): Unsubscribe;
    onType(
      type: "equipment.created" | "equipment.updated" | "equipment.removed" | "zone.updated" | "zone.removed",
      handler: (event: unknown) => void,
    ): Unsubscribe;
  };
  equipmentManager: {
    getAll(): Equipment[];
    getById(id: string): Equipment | undefined | null;
    getByIdWithDetails(id: string): EquipmentDetails | undefined | null;
  };
  zoneManager: {
    getById(id: string): Zone | undefined | null;
  };
  dispatchOrder(
    equipmentId: string,
    alias: string,
    value: unknown,
  ): Promise<{ success?: boolean; error?: string } | void>;
}

interface RecipeInstanceHandle {
  stop(): void;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  tile?: RecipeTileDef;
  i18n?: Record<string, unknown>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): RecipeInstanceHandle;
}

// ------------------------------------------------------------
// The bridge's aliases: they belong to the plugin, which ships them.
// ------------------------------------------------------------
const ORDER_CATALOG = "home_catalog";
const ORDER_READINGS = "home_readings";
const ORDER_SERIES = "home_series";
const ORDER_RESULT = "home_result";
const DATA_SELECTION = "home_selection";
const DATA_COMMAND = "home_command";
const DATA_SEQ = "home_command_seq";

export const LIGHT_TYPES = ["light_onoff", "light_dimmable", "light_color"] as const;
export const CATALOG_TYPES = [
  "sensor",
  "thermostat",
  "weather",
  "energy_meter",
  "main_energy_meter",
  ...LIGHT_TYPES,
  "switch",
] as const;
/** The aliases whose hourly value makes a 24-bar series (Sowel's aggregators; Netatmo's native one). */
export const HOURLY_ALIASES = ["rain_1h", "sum_rain_1", "energy_hour"] as const;

export const READINGS_EVERY_MS = 60_000;
export const SERIES_EVERY_MS = 15 * 60_000;
const CATALOG_EVERY_MS = 60 * 60_000;
const CATALOG_DEBOUNCE_MS = 2_000;
const HOUR_MS = 60 * 60_000;
export const MAX_COMMAND_AGE_MS = 60_000;
export const MAX_COMMANDS_PER_HOUR = 20;
const MAX_BUCKETS = 24;
/** More pairs than guestFlow could ever show on one page: the rest is ignored. */
export const MAX_SELECTION = 200;
const SELECTION_DEBOUNCE_MS = 2_000;

/** guestFlow's own limits (homePayloads.js): beyond them a whole call is refused. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const ALIAS_RE = /^[A-Za-z0-9_.-]{1,60}$/;
const MAX_EQUIPMENTS = 500;
const MAX_READINGS_PER_EQUIPMENT = 40;

export type Reason = "not_a_light" | "not_entrusted" | "too_old" | "rate_limited" | "order_failed" | "invalid_command";

// ------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------

/** A light: one of the light types, or a switch carrying a light's state. */
export function isLight(eq: EquipmentDetails | undefined | null): boolean {
  if (!eq) return false;
  if ((LIGHT_TYPES as readonly string[]).includes(eq.type ?? "")) return true;
  if (eq.type !== "switch") return false;
  return (
    (eq.dataBindings ?? []).some((b) => b.category === "light_state") ||
    (eq.orderBindings ?? []).some((o) => o.category === "light_toggle")
  );
}

/** Is this equipment described in the catalogue at all? (a switch only when it is a light) */
export function isCatalogued(eq: EquipmentDetails): boolean {
  if (eq.type === "switch") return isLight(eq);
  return (CATALOG_TYPES as readonly string[]).includes(eq.type ?? "");
}

/** « Gîte › Chambre » — the house's root zone left out when the equipment lives below it. */
export function zonePathOf(zones: RecipeContext["zoneManager"], zoneId: string | undefined): string {
  const names: string[] = [];
  const seen = new Set<string>();
  let zone = zoneId ? zones.getById(zoneId) : null;
  while (zone && !seen.has(zone.id)) {
    seen.add(zone.id);
    names.unshift(zone.name.trim());
    zone = zone.parentId ? zones.getById(zone.parentId) : null;
  }
  if (names.length > 1) names.shift();
  return names.join(" › ").slice(0, 200);
}

export interface CatalogEntry {
  id: string;
  name: string;
  zonePath: string;
  type: string;
  guestSwitchable?: boolean;
  readings: { alias: string; category: string; unit: string | null }[];
}

function readingsOf(eq: EquipmentDetails): CatalogEntry["readings"] {
  const out: CatalogEntry["readings"] = [];
  const seen = new Set<string>();
  for (const b of [...(eq.dataBindings ?? []), ...(eq.computedData ?? [])]) {
    if (!ALIAS_RE.test(b.alias) || seen.has(b.alias)) continue;
    seen.add(b.alias);
    const unit = typeof b.unit === "string" && b.unit.length <= 16 ? b.unit : null;
    out.push({ alias: b.alias, category: (b.category || "generic").slice(0, 60), unit });
  }
  return out.slice(0, MAX_READINGS_PER_EQUIPMENT);
}

/**
 * The house as guestFlow may know it: every catalogued equipment, its readable
 * values, NO value. `guestSwitchable` is true exactly for the whitelisted lights.
 */
export function buildCatalog(
  ctx: Pick<RecipeContext, "equipmentManager" | "zoneManager">,
  whitelist: ReadonlySet<string>,
  /** The bridge itself: it is the channel, not part of the house. */
  exclude?: string,
): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  for (const e of ctx.equipmentManager.getAll()) {
    if (e.id === exclude || !ID_RE.test(e.id)) continue;
    const eq = ctx.equipmentManager.getByIdWithDetails(e.id);
    if (!eq || !isCatalogued(eq)) continue;
    const name = (eq.name ?? e.name ?? "").trim().slice(0, 120) || eq.id;
    const entry: CatalogEntry = {
      id: eq.id,
      name,
      zonePath: zonePathOf(ctx.zoneManager, eq.zoneId ?? e.zoneId),
      type: eq.type as string,
      readings: readingsOf(eq),
    };
    if (isLight(eq)) entry.guestSwitchable = whitelist.has(eq.id);
    entries.push(entry);
  }
  entries.sort(
    (a, b) => a.zonePath.localeCompare(b.zonePath, "fr") || a.name.localeCompare(b.name, "fr") || a.id.localeCompare(b.id),
  );
  return entries.slice(0, MAX_EQUIPMENTS);
}

export interface Pair {
  equipmentId: string;
  alias: string;
}

export function parseSelection(value: unknown): Pair[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Pair => !!p && typeof p.equipmentId === "string" && typeof p.alias === "string",
    );
  } catch {
    return [];
  }
}

/** The current value of one alias, from a device binding or a computed cumul. */
export function currentOf(
  eq: EquipmentDetails | undefined | null,
  alias: string,
): { value: unknown; unit: string | null; lastUpdated: string | null } | null {
  if (!eq) return null;
  const b = [...(eq.dataBindings ?? []), ...(eq.computedData ?? [])].find((x) => x.alias === alias);
  if (!b) return null;
  return { value: b.value, unit: typeof b.unit === "string" ? b.unit : null, lastUpdated: b.lastUpdated ?? null };
}

const isSendable = (v: unknown) =>
  v === null ||
  typeof v === "boolean" ||
  (typeof v === "number" && Number.isFinite(v)) ||
  (typeof v === "string" && v.length <= 40);

export interface Reading {
  equipmentId: string;
  alias: string;
  value: unknown;
  unit: string | null;
  measuredAt: string;
}

/**
 * May this pair leave the house? Only an alias the catalogue describes, of a
 * catalogued equipment, never the bridge: guestFlow writes the selection, so
 * the selection alone proves nothing.
 */
export function isReadable(eq: EquipmentDetails | undefined | null, alias: string, bridgeId?: string): eq is EquipmentDetails {
  if (!eq || eq.id === bridgeId || !ID_RE.test(eq.id) || !isCatalogued(eq)) return false;
  return readingsOf(eq).some((r) => r.alias === alias);
}

/** The selection's values, and nothing else. A pair outside the catalogue, or whose equipment is gone, is skipped. */
export function buildReadings(
  ctx: Pick<RecipeContext, "equipmentManager">,
  selection: Pair[],
  bridgeId?: string,
): Reading[] {
  const out: Reading[] = [];
  for (const p of selection.slice(0, MAX_SELECTION)) {
    const eq = ctx.equipmentManager.getByIdWithDetails(p.equipmentId);
    if (!isReadable(eq, p.alias, bridgeId)) continue;
    const cur = currentOf(eq, p.alias);
    if (!cur || !cur.lastUpdated || Number.isNaN(Date.parse(cur.lastUpdated)) || !isSendable(cur.value)) continue;
    out.push({ equipmentId: p.equipmentId, alias: p.alias, value: cur.value, unit: cur.unit, measuredAt: cur.lastUpdated });
  }
  return out;
}

export interface Bucket {
  time: string;
  value: number;
}

export interface SeriesStore {
  /** pairKey → the last sample of the hour in progress. */
  pending: Record<string, { hour: number; value: number }>;
  /** pairKey → the closed hours, oldest first, 24 at most. */
  buckets: Record<string, Bucket[]>;
}

export const pairKey = (p: Pair) => `${p.equipmentId}|${p.alias}`;
const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

/**
 * One sample of an hourly alias. When the hour turned, the previous hour's last
 * sample becomes its bucket. Returns the new store (the input is not mutated).
 */
export function sampleHourly(store: SeriesStore, key: string, value: unknown, now: number): SeriesStore {
  const next: SeriesStore = { pending: { ...store.pending }, buckets: { ...store.buckets } };
  const hour = hourOf(now);
  const pending = next.pending[key];
  if (pending && pending.hour < hour) {
    // Only the hour just closed: a sample left from before a long stop is no measure of it.
    if (pending.hour === hour - HOUR_MS) {
      const list = [...(next.buckets[key] ?? []), { time: new Date(pending.hour).toISOString(), value: pending.value }];
      next.buckets[key] = list.slice(-MAX_BUCKETS);
    }
    delete next.pending[key];
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    next.pending[key] = { hour, value };
  }
  // The window is the last 24 hours, whatever the number of buckets kept.
  const oldest = hour - MAX_BUCKETS * HOUR_MS;
  if (next.buckets[key]) next.buckets[key] = next.buckets[key].filter((b) => Date.parse(b.time) >= oldest);
  return next;
}

export interface Command {
  id: number;
  propertyId: number;
  equipmentId: string;
  value: "on" | "off";
  issuedAt: string;
}

/** The command as the plugin published it; `id` alone when the rest is unusable. */
export function parseCommand(value: unknown): { command: Command } | { id: number | null } {
  let raw: Record<string, unknown>;
  try {
    raw = typeof value === "string" ? (JSON.parse(value) as Record<string, unknown>) : {};
  } catch {
    return { id: null };
  }
  const id = raw && Number.isSafeInteger(raw.id) && (raw.id as number) > 0 ? (raw.id as number) : null;
  if (
    id === null ||
    !Number.isSafeInteger(raw.propertyId) ||
    typeof raw.equipmentId !== "string" ||
    (raw.value !== "on" && raw.value !== "off") ||
    typeof raw.issuedAt !== "string"
  ) {
    return { id };
  }
  return {
    command: {
      id,
      propertyId: raw.propertyId as number,
      equipmentId: raw.equipmentId,
      value: raw.value,
      issuedAt: raw.issuedAt,
    },
  };
}

/** A request counter only ever counts up. The first reading is the starting point, never a command. */
export function isNewCommand(previous: number | null, incoming: unknown): boolean {
  if (typeof incoming !== "number" || !Number.isFinite(incoming)) return false;
  if (previous === null) return false;
  return incoming > previous;
}

/**
 * The checks, in order. `history` is the times of the commands already let
 * through for this light; returns the refusal, or null.
 */
export function refusalOf(
  command: Command,
  light: EquipmentDetails | undefined | null,
  whitelist: ReadonlySet<string>,
  history: number[],
  now: number,
): Reason | null {
  // The whitelist first: a refusal must not tell guestFlow what an unknown id is.
  if (!whitelist.has(command.equipmentId)) return "not_entrusted";
  if (!isLight(light)) return "not_a_light";
  const age = now - Date.parse(command.issuedAt);
  // A command from the future is no fresher than an old one: a clock is wrong somewhere.
  if (!Number.isFinite(age) || age >= MAX_COMMAND_AGE_MS || age <= -MAX_COMMAND_AGE_MS) return "too_old";
  if (history.filter((t) => now - t < HOUR_MS).length >= MAX_COMMANDS_PER_HOUR) return "rate_limited";
  return null;
}

/** The light's on/off order and the value for it: true/false on a boolean, the enum's own ON/OFF otherwise. */
export function lightOrder(
  light: EquipmentDetails,
  target: "on" | "off",
): { alias: string; value: unknown } | null {
  const orders = light.orderBindings ?? [];
  const order =
    orders.find((o) => o.alias === "state") ??
    orders.find((o) => o.category === "light_toggle" || o.category === "toggle_power");
  if (!order) return null;
  if (order.type === "boolean") return { alias: order.alias, value: target === "on" };
  // Only an enum that names on and off: any other order type is no light switch we know how to drive.
  const match = order.enumValues?.find((v) => v.toLowerCase() === target);
  return match ? { alias: order.alias, value: match } : null;
}

/** A restored `{ key: number[] }`, whatever was stored: anything else is dropped. */
export function timesOf(raw: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) out[k] = v.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  }
  return out;
}

/** A restored `{ key: number }`, whatever was stored. */
export function timeOf(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** The last hour only; an empty key is dropped, so the store never grows past an hour of commands. */
export function pruneTimes(rate: Record<string, number[]>, now: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, list] of Object.entries(rate)) {
    const kept = list.filter((t) => now - t < HOUR_MS);
    if (kept.length) out[k] = kept;
  }
  return out;
}

export function recentOf(seen: Record<string, number>, now: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(seen)) if (now - t < HOUR_MS) out[k] = t;
  return out;
}

/** The series of the pairs still selected, and no other. */
export function keepSeries(store: SeriesStore, keys: ReadonlySet<string>): SeriesStore {
  const pick = <T>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => keys.has(k)));
  return { pending: pick(store.pending), buckets: pick(store.buckets) };
}

// ------------------------------------------------------------
// Slots and i18n
// ------------------------------------------------------------

const FR = {
  name: "Domotique des voyageurs",
  description:
    "Montre aux voyageurs les mesures de la maison et leur laisse allumer ou éteindre les lumières que vous leur confiez, par le plugin guestFlow. Une seule pour toute la maison.",
  slots: {
    zone: { name: "Zone", description: "La zone où ranger la tuile" },
    bridge: {
      name: "Pont guestFlow",
      description: "L'équipement lié au device « home-bridge » (Domotique GuestFlow) du plugin guestFlow.",
    },
    lights: {
      name: "Lumières confiées aux voyageurs",
      description:
        "Les seules lumières qu'un voyageur peut allumer ou éteindre depuis l'appli, quoi que guestFlow demande. Laquelle est pilotable dans quel logement se règle dans le Studio.",
    },
  },
};

function buildSlots(): RecipeSlotDef[] {
  return [
    { id: "zone", name: "Zone", description: "The zone the tile lives in", type: "zone", required: true },
    {
      id: "bridge",
      name: "guestFlow bridge",
      description: "The equipment bound to the guestFlow plugin's « home-bridge » device (Domotique GuestFlow).",
      type: "equipment",
      required: true,
      constraints: { crossZone: true },
    },
    {
      id: "lights",
      name: "Lights entrusted to guests",
      description:
        "The only lights a guest may switch from the app, whatever guestFlow asks. Which one is switchable in which lodging is set in guestFlow's Studio.",
      type: "equipment",
      required: false,
      list: true,
      constraints: { equipmentType: ["light_onoff", "light_dimmable", "light_color", "switch"], crossZone: true },
    },
  ];
}

export function whitelistOf(params: Record<string, unknown>): Set<string> {
  const raw = params.lights;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" && raw ? raw.split(",") : [];
  return new Set(list.filter((x): x is string => typeof x === "string" && x.length > 0));
}

const hhmm = (ms: number): string =>
  new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(ms));

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createRecipe(): RecipeDefinition {
  return {
    id: "guest-home",
    name: "Guest home automation",
    description:
      "Shows guests the house's readings and lets them switch the lights you entrust to them, through the guestFlow plugin. One for the whole house.",
    slots: buildSlots(),
    tile: { icon: "Lightbulb" },
    i18n: { fr: FR },

    validate(params, ctx) {
      if (!params.zone) throw new Error("Zone is required");
      const bridgeId = typeof params.bridge === "string" ? params.bridge : "";
      if (!bridgeId) throw new Error("The guestFlow bridge equipment is required");
      const bridge = ctx.equipmentManager.getByIdWithDetails(bridgeId);
      if (!bridge) throw new Error("guestFlow bridge equipment not found");
      const orders = (bridge.orderBindings ?? []).map((o) => o.alias);
      for (const alias of [ORDER_CATALOG, ORDER_READINGS, ORDER_SERIES, ORDER_RESULT]) {
        if (!orders.includes(alias)) {
          throw new Error(`The bridge equipment carries no « ${alias} » order — bind the home-bridge device's orders to it`);
        }
      }
      const data = (bridge.dataBindings ?? []).map((d) => d.alias);
      for (const alias of [DATA_SELECTION, DATA_COMMAND, DATA_SEQ]) {
        if (!data.includes(alias)) {
          throw new Error(`The bridge equipment has no « ${alias} » reading — bind the home-bridge device's data to it`);
        }
      }
      for (const id of whitelistOf(params)) {
        const light = ctx.equipmentManager.getByIdWithDetails(id);
        if (!light) throw new Error(`Entrusted light not found: ${id}`);
        if (!isLight(light)) throw new Error(`« ${light.name ?? id} » is not a light: only lights can be entrusted`);
      }
    },

    createInstance(params, ctx) {
      const bridgeId = params.bridge as string;
      const whitelist = whitelistOf(params);

      let stopped = false;
      let lastCatalog = "";
      let catalogTimer: ReturnType<typeof setTimeout> | null = null;
      let selectionTimer: ReturnType<typeof setTimeout> | null = null;
      /** The counter as last seen. `null` until the first reading — see isNewCommand. */
      let lastSeq: number | null = null;
      let queue: Promise<void> = Promise.resolve();
      let executed = 0;
      let lastAt: number | null = null;

      const restoredSeries = ctx.state.get("series") as SeriesStore | null;
      let series: SeriesStore =
        restoredSeries && typeof restoredSeries === "object" && restoredSeries.pending && restoredSeries.buckets
          ? restoredSeries
          : { pending: {}, buckets: {} };
      let rate = timesOf(ctx.state.get("rate"));
      /** Command id → when it was handled: a command is acted on once, whatever guestFlow resends. */
      let seen = timeOf(ctx.state.get("seen"));

      const summary = (): void => {
        const n = whitelist.size;
        const base = `${n} lumière${n > 1 ? "s" : ""} confiée${n > 1 ? "s" : ""}`;
        ctx.state.set(
          "summary",
          executed && lastAt ? `${base} · ${executed} commande${executed > 1 ? "s" : ""}, dernière à ${hhmm(lastAt)}` : base,
        );
      };

      const send = async (alias: string, payload: unknown, what: string): Promise<boolean> => {
        try {
          const res = await ctx.dispatchOrder(bridgeId, alias, JSON.stringify(payload));
          if (res && res.success === false) throw new Error(res.error ?? "échec");
          return true;
        } catch (err) {
          ctx.log(`${what} non transmis au plugin guestFlow — ${errText(err)}`, "warn");
          return false;
        }
      };

      const bridgeValue = (alias: string): unknown =>
        (ctx.equipmentManager.getByIdWithDetails(bridgeId)?.dataBindings ?? []).find((b) => b.alias === alias)?.value;

      const selection = (): Pair[] => parseSelection(bridgeValue(DATA_SELECTION));

      // --- catalogue ---

      const pushCatalog = async (force: boolean): Promise<void> => {
        if (stopped) return;
        const catalog = buildCatalog(ctx, whitelist, bridgeId);
        const text = JSON.stringify(catalog);
        if (!force && text === lastCatalog) return;
        lastCatalog = text;
        if (!(await send(ORDER_CATALOG, catalog, "catalogue"))) lastCatalog = "";
      };

      const catalogSoon = (): void => {
        if (stopped || catalogTimer) return;
        catalogTimer = setTimeout(() => {
          catalogTimer = null;
          void pushCatalog(false);
        }, CATALOG_DEBOUNCE_MS);
      };

      // --- readings and series ---

      const pushReadings = async (): Promise<void> => {
        if (stopped) return;
        const now = Date.now();
        const pairs = selection();
        let changed = false;
        for (const p of pairs) {
          if (!(HOURLY_ALIASES as readonly string[]).includes(p.alias)) continue;
          const cur = currentOf(ctx.equipmentManager.getByIdWithDetails(p.equipmentId), p.alias);
          series = sampleHourly(series, pairKey(p), cur?.value, now);
          changed = true;
        }
        series = keepSeries(series, new Set(pairs.map(pairKey)));
        if (changed) ctx.state.set("series", series);
        const readings = buildReadings(ctx, pairs, bridgeId);
        if (readings.length) await send(ORDER_READINGS, readings, "relevés");
      };

      const pushSeries = async (): Promise<void> => {
        if (stopped) return;
        const out = selection()
          .slice(0, MAX_SELECTION)
          .filter((p) => (HOURLY_ALIASES as readonly string[]).includes(p.alias))
          .filter((p) => isReadable(ctx.equipmentManager.getByIdWithDetails(p.equipmentId), p.alias, bridgeId))
          .map((p) => ({ equipmentId: p.equipmentId, alias: p.alias, buckets: series.buckets[pairKey(p)] ?? [] }))
          .filter((s) => s.buckets.length > 0);
        if (out.length) await send(ORDER_SERIES, out, "séries horaires");
      };

      // --- commands ---

      const report = async (id: number, reason: Reason | null): Promise<void> => {
        await send(ORDER_RESULT, reason ? { id, ok: false, reason } : { id, ok: true }, `verdict de la commande ${id}`);
      };

      const execute = async (raw: unknown): Promise<void> => {
        if (stopped) return;
        const parsed = parseCommand(raw);
        if (!("command" in parsed)) {
          ctx.log(`commande ${parsed.id ?? "?"} illisible — rien n'est actionné`, "warn");
          if (parsed.id !== null) await report(parsed.id, "invalid_command");
          return;
        }
        const command = parsed.command;
        const now = Date.now();
        seen = recentOf(seen, now);
        if (seen[String(command.id)] !== undefined) {
          ctx.log(`commande ${command.id} déjà traitée — rien n'est actionné à nouveau`, "warn");
          return;
        }
        seen = { ...seen, [String(command.id)]: now };
        ctx.state.set("seen", seen);
        const light = ctx.equipmentManager.getByIdWithDetails(command.equipmentId);
        // Per light: the lodging is chosen by guestFlow, so a limit on it bounds nothing.
        rate = pruneTimes(rate, now);
        const key = command.equipmentId;
        const history = rate[key] ?? [];
        const refusal = refusalOf(command, light, whitelist, history, now);
        if (refusal) {
          ctx.log(`commande ${command.id} refusée (${refusal}) pour « ${light?.name ?? command.equipmentId} »`, "warn");
          await report(command.id, refusal);
          return;
        }
        rate = { ...rate, [key]: [...history, now] };
        ctx.state.set("rate", rate);

        const order = lightOrder(light as EquipmentDetails, command.value);
        let failure: string | null = order ? null : "aucun ordre « state »";
        if (order) {
          try {
            const res = await ctx.dispatchOrder(command.equipmentId, order.alias, order.value);
            if (res && res.success === false) failure = res.error ?? "échec";
          } catch (err) {
            failure = errText(err);
          }
        }
        if (failure) {
          ctx.log(`commande ${command.id} en échec sur « ${light?.name ?? command.equipmentId} » — ${failure}`, "error");
          await report(command.id, "order_failed");
          return;
        }
        executed += 1;
        lastAt = now;
        ctx.log(`commande ${command.id} : « ${light?.name ?? command.equipmentId} » ${command.value === "on" ? "allumée" : "éteinte"} par un voyageur`);
        summary();
        await report(command.id, null);
      };

      // --- wiring ---

      const unsubData = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (event.equipmentId !== bridgeId) return;
        if (event.alias === DATA_SEQ) {
          const incoming = event.value;
          if (!isNewCommand(lastSeq, incoming)) {
            // Also the very first reading after a start: never a command.
            if (typeof incoming === "number" && Number.isFinite(incoming)) lastSeq = incoming;
            return;
          }
          lastSeq = incoming as number;
          // Read now: the plugin wrote the command just before moving the counter.
          const raw = bridgeValue(DATA_COMMAND);
          queue = queue
            .then(() => execute(raw))
            .catch((err) => ctx.log(`commande non traitée — ${errText(err)}`, "error"));
          return;
        }
        if (event.alias === DATA_SELECTION && !stopped && !selectionTimer) {
          selectionTimer = setTimeout(() => {
            selectionTimer = null;
            void pushReadings();
          }, SELECTION_DEBOUNCE_MS);
        }
      });
      const unsubs = [
        ctx.eventBus.onType("equipment.created", catalogSoon),
        ctx.eventBus.onType("equipment.updated", catalogSoon),
        ctx.eventBus.onType("equipment.removed", catalogSoon),
        ctx.eventBus.onType("zone.updated", catalogSoon),
        ctx.eventBus.onType("zone.removed", catalogSoon),
      ];

      const initialSeq = bridgeValue(DATA_SEQ);
      if (typeof initialSeq === "number" && Number.isFinite(initialSeq)) lastSeq = initialSeq;

      const readingsTimer = setInterval(() => void pushReadings(), READINGS_EVERY_MS);
      const seriesTimer = setInterval(() => void pushSeries(), SERIES_EVERY_MS);
      // Hourly, whatever changed: a plugin restarted without its memory gets it back.
      const catalogHourly = setInterval(() => void pushCatalog(true), CATALOG_EVERY_MS);

      void pushCatalog(false);
      void pushSeries();
      summary();
      ctx.log(`Recette démarrée : ${whitelist.size} lumière${whitelist.size > 1 ? "s" : ""} confiée${whitelist.size > 1 ? "s" : ""} aux voyageurs`);

      return {
        stop(): void {
          stopped = true;
          unsubData();
          for (const u of unsubs) u();
          clearInterval(readingsTimer);
          clearInterval(seriesTimer);
          clearInterval(catalogHourly);
          if (catalogTimer) clearTimeout(catalogTimer);
          catalogTimer = null;
          if (selectionTimer) clearTimeout(selectionTimer);
          selectionTimer = null;
        },
      };
    },
  };
}
