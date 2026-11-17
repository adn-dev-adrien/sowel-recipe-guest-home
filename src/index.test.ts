import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bucketsOf,
  buildCatalog,
  createRecipe,
  hasChanged,
  historyAliasOf,
  type HistoryHelper,
  lightOrder,
  pruneTimes,
  timeOf,
  timesOf,
  type EquipmentDetails,
  type RecipeContext,
} from "./index.js";

// What these tests guard: the whitelist is the house's boundary. A command from
// guestFlow must never reach anything but an entrusted light — not on a
// restart, not on a repeated counter or id, not when stale, not beyond 20 an
// hour per light — and every refusal is reported. Only the shared sensors and
// the entrusted lights are ever described; values leave only for the selected
// pairs the catalogue describes, only when they changed, and every figure is
// one Sowel already holds.

type Handler = (event: Record<string, unknown>) => void;

const BRIDGE = "eq-bridge";
const NOW = Date.parse("2026-11-15T10:30:00Z");
const ISO = (ms: number) => new Date(ms).toISOString();

function makeHouse() {
  const zones = new Map([
    ["root", { id: "root", name: "Maison", parentId: null }],
    ["gite", { id: "gite", name: "Gîte", parentId: "root" }],
    ["salon", { id: "salon", name: "Salon", parentId: "gite" }],
    ["ext", { id: "ext", name: "Extérieur", parentId: "root" }],
  ]);
  const eqs: EquipmentDetails[] = [
    {
      id: BRIDGE,
      name: "Domotique GuestFlow",
      type: "sensor",
      zoneId: "root",
      dataBindings: [
        { alias: "home_selection", category: "generic", value: "[]" },
        { alias: "home_command", category: "generic", value: "" },
        { alias: "home_command_seq", category: "generic", value: 100 },
      ],
      orderBindings: ["home_catalog", "home_readings", "home_series", "home_result"].map((alias) => ({ alias, type: "text" })),
    },
    {
      id: "eq-temp",
      name: "Thermomètre salon",
      type: "sensor",
      zoneId: "salon",
      dataBindings: [
        { alias: "temperature", category: "temperature", unit: "°C", value: 21.4, lastUpdated: ISO(NOW - 30_000) },
        { alias: "humidity", category: "humidity", unit: "%", value: 48, lastUpdated: ISO(NOW - 30_000) },
      ],
      computedData: [
        { alias: "temperature_min_today", category: "temperature", unit: "°C", value: 18.2, lastUpdated: ISO(NOW - 30_000) },
        { alias: "temperature_max_today", category: "temperature", unit: "°C", value: 22.9, lastUpdated: ISO(NOW - 30_000) },
      ],
      orderBindings: [],
    },
    {
      id: "eq-cave",
      name: "Cave",
      type: "sensor",
      zoneId: "root",
      dataBindings: [{ alias: "temperature", category: "temperature", unit: "°C", value: 12, lastUpdated: ISO(NOW) }],
      orderBindings: [],
    },
    {
      id: "eq-meter",
      name: "Compteur gîte",
      type: "energy_meter",
      zoneId: "gite",
      dataBindings: [{ alias: "energy", category: "energy", unit: "Wh", value: 0, lastUpdated: ISO(NOW) }],
      computedData: [{ alias: "energy_hour", category: "energy", unit: "Wh", value: 40, lastUpdated: ISO(NOW) }],
      orderBindings: [],
    },
    {
      id: "eq-weather",
      name: "Station",
      type: "weather",
      zoneId: "ext",
      dataBindings: [{ alias: "temperature", category: "temperature_outdoor", unit: "°C", value: 9, lastUpdated: ISO(NOW) }],
      computedData: [{ alias: "rain_1h", category: "rain", unit: "mm", value: 0.4, lastUpdated: ISO(NOW) }],
      orderBindings: [],
    },
    {
      id: "eq-lamp",
      name: "Lampe salon",
      type: "light_onoff",
      zoneId: "salon",
      dataBindings: [{ alias: "state", category: "light_state", value: "OFF", lastUpdated: ISO(NOW) }],
      orderBindings: [{ alias: "state", type: "enum", category: "light_toggle", enumValues: ["ON", "OFF"] }],
    },
    {
      id: "eq-terrace",
      name: "Terrasse",
      type: "switch",
      zoneId: "ext",
      dataBindings: [{ alias: "state", category: "light_state", value: false, lastUpdated: ISO(NOW) }],
      orderBindings: [{ alias: "state", type: "boolean", category: "light_toggle" }],
    },
    {
      id: "eq-hall",
      name: "Couloir",
      type: "light_dimmable",
      zoneId: "gite",
      dataBindings: [{ alias: "state", category: "light_state", value: "OFF", lastUpdated: ISO(NOW) }],
      orderBindings: [{ alias: "state", type: "enum", enumValues: ["ON", "OFF"] }],
    },
    {
      id: "eq-pump",
      name: "Pompe",
      type: "switch",
      zoneId: "ext",
      dataBindings: [{ alias: "state", category: "generic", value: false, lastUpdated: ISO(NOW) }],
      orderBindings: [{ alias: "state", type: "boolean", category: "toggle_power" }],
    },
    { id: "eq-gate", name: "Portail", type: "gate", zoneId: "ext", dataBindings: [], orderBindings: [{ alias: "command" }] },
  ];
  return { zones, eqs };
}

type History = HistoryHelper;

function makeCtx(opts: { state?: Record<string, unknown>; failOrders?: boolean; failBridge?: () => boolean; history?: History } = {}) {
  const { zones, eqs } = makeHouse();
  const logs: { message: string; level: string }[] = [];
  const state = new Map<string, unknown>(Object.entries(opts.state ?? {}));
  const orders: { equipmentId: string; alias: string; value: unknown }[] = [];
  const handlers: { type: string; handler: Handler }[] = [];
  const ctx: RecipeContext = {
    log: (message, level = "info") => void logs.push({ message, level }),
    state: { get: (k) => (state.has(k) ? state.get(k) : null), set: (k, v) => void state.set(k, structuredClone(v)) },
    eventBus: {
      onType: ((type: string, handler: Handler) => {
        const entry = { type, handler };
        handlers.push(entry);
        return () => handlers.splice(handlers.indexOf(entry), 1);
      }) as RecipeContext["eventBus"]["onType"],
    },
    equipmentManager: {
      getAll: () => eqs.map(({ id, name, type, zoneId }) => ({ id, name, type, zoneId })),
      getById: (id) => eqs.find((e) => e.id === id),
      getByIdWithDetails: (id) => eqs.find((e) => e.id === id),
    },
    zoneManager: { getById: (id) => zones.get(id) },
    dispatchOrder: async (equipmentId, alias, value) => {
      if (equipmentId === BRIDGE && opts.failBridge?.()) return { success: false, error: "plugin stopped" };
      orders.push({ equipmentId, alias, value });
      if (opts.failOrders && equipmentId !== BRIDGE) return { success: false, error: "device offline" };
      return { success: true };
    },
    ...(opts.history ? { helpers: { history: opts.history } } : {}),
  };
  const emit = (type: string, event: Record<string, unknown>) => {
    for (const h of handlers.filter((x) => x.type === type)) h.handler(event);
  };
  const bridge = eqs.find((e) => e.id === BRIDGE)!;
  const setBridge = (alias: string, value: unknown) => {
    bridge.dataBindings!.find((b) => b.alias === alias)!.value = value;
    emit("equipment.data.changed", { equipmentId: BRIDGE, alias, value });
  };
  let seq = 100;
  const sendCommand = (cmd: Record<string, unknown>) => {
    setBridge("home_command", JSON.stringify(cmd));
    seq += 1;
    setBridge("home_command_seq", seq);
  };
  const toBridge = (alias: string) =>
    orders.filter((o) => o.equipmentId === BRIDGE && o.alias === alias).map((o) => JSON.parse(String(o.value)));
  const toHouse = () => orders.filter((o) => o.equipmentId !== BRIDGE);
  return { ctx, logs, state, orders, handlers, emit, eqs, setBridge, sendCommand, toBridge, toHouse };
}

const PARAMS = { zone: "root", bridge: BRIDGE, sensors: ["eq-temp", "eq-weather", "eq-meter"], lights: ["eq-lamp", "eq-terrace"] };
const cmd = (id: number, equipmentId: string, value = "on", age = 5_000, propertyId = 1) => ({
  id,
  propertyId,
  equipmentId,
  value,
  issuedAt: ISO(Date.now() - age),
});
const flush = () => vi.advanceTimersByTimeAsync(0);

afterEach(() => {
  vi.useRealTimers();
});

describe("validation", () => {
  it("wants the bridge with its four orders and three data, and only lights in the whitelist", () => {
    const recipe = createRecipe();
    const { ctx, eqs } = makeCtx();
    expect(() => recipe.validate(PARAMS, ctx)).not.toThrow();
    expect(() => recipe.validate({ ...PARAMS, lights: ["eq-pump"] }, ctx)).toThrow(/not a light/);
    expect(() => recipe.validate({ ...PARAMS, lights: ["eq-gate"] }, ctx)).toThrow(/not a light/);
    expect(() => recipe.validate({ ...PARAMS, lights: ["nope"] }, ctx)).toThrow(/not found/);
    expect(() => recipe.validate({ ...PARAMS, sensors: ["nope"] }, ctx)).toThrow(/Shared sensor not found/);
    expect(() => recipe.validate({ ...PARAMS, sensors: ["eq-gate"] }, ctx)).toThrow(/cannot be shared/);
    eqs[0].orderBindings = eqs[0].orderBindings!.filter((o) => o.alias !== "home_result");
    expect(() => recipe.validate(PARAMS, ctx)).toThrow(/home_result/);
  });

  it("declares the whitelist as a multi-select of light equipments", () => {
    const slot = createRecipe().slots.find((s) => s.id === "lights")!;
    expect(slot).toMatchObject({ type: "equipment", list: true });
    expect(slot.constraints?.equipmentType).toEqual(["light_onoff", "light_dimmable", "light_color", "switch"]);
  });

  it("declares « Capteurs partagés » as a multi-select of sensors, meters and stations, no light", () => {
    const slot = createRecipe().slots.find((s) => s.id === "sensors")!;
    expect(slot).toMatchObject({ type: "equipment", list: true, required: false });
    expect(slot.constraints?.equipmentType).toEqual(["sensor", "thermostat", "weather", "energy_meter", "main_energy_meter"]);
  });
});

describe("the catalogue", () => {
  it("describes only the shared sensors and the entrusted lights, with zone path and readable values, no value", () => {
    const { ctx } = makeCtx();
    const catalog = buildCatalog(ctx, new Set(PARAMS.lights), BRIDGE, new Set(PARAMS.sensors));
    // By zone path then name. Left out: the cellar (not shared), the hall light (not entrusted), the bridge, the
    // pump, the gate — whatever their type.
    expect(catalog.map((e) => e.id)).toEqual(["eq-weather", "eq-terrace", "eq-meter", "eq-lamp", "eq-temp"]);
    const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));
    expect(byId["eq-temp"]).toEqual({
      id: "eq-temp",
      name: "Thermomètre salon",
      zonePath: "Gîte › Salon",
      type: "sensor",
      readings: [
        { alias: "temperature", category: "temperature", unit: "°C" },
        { alias: "humidity", category: "humidity", unit: "%" },
        { alias: "temperature_min_today", category: "temperature", unit: "°C" },
        { alias: "temperature_max_today", category: "temperature", unit: "°C" },
      ],
    });
    expect(byId["eq-weather"].readings).toContainEqual({ alias: "rain_1h", category: "rain", unit: "mm" });
    expect(byId["eq-lamp"].guestSwitchable).toBe(true);
    expect(byId["eq-terrace"].guestSwitchable).toBe(true);
    expect(byId["eq-temp"]).not.toHaveProperty("guestSwitchable");
    expect(byId["eq-hall"]).toBeUndefined();
    expect(byId["eq-cave"]).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toMatch(/21\.4|"OFF"|0\.4/);
  });

  it("describes no sensor at all when none is shared; a gate shared by an old configuration stays out", () => {
    const { ctx } = makeCtx();
    expect(buildCatalog(ctx, new Set(PARAMS.lights), BRIDGE, new Set()).map((e) => e.id)).toEqual(["eq-terrace", "eq-lamp"]);
    expect(buildCatalog(ctx, new Set(), BRIDGE, new Set(["eq-gate", BRIDGE])).map((e) => e.id)).toEqual([]);
  });

  it("is sent at start, again on an equipment change, never twice the same", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, emit, eqs, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    await flush();
    expect(toBridge("home_catalog")).toHaveLength(1);
    emit("equipment.updated", {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_catalog")).toHaveLength(1);
    eqs.find((e) => e.id === "eq-temp")!.name = "Salon";
    emit("equipment.updated", {});
    emit("equipment.updated", {});
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_catalog")).toHaveLength(2);
    expect(toBridge("home_catalog")[1].find((e: { id: string }) => e.id === "eq-temp").name).toBe("Salon");
    // No hourly resend of an unchanged catalogue: the plugin keeps it and resends it to guestFlow itself.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(toBridge("home_catalog")).toHaveLength(2);
    handle.stop();
  });
});

describe("readings", () => {
  const SELECTION = [
    { equipmentId: "eq-temp", alias: "temperature" },
    { equipmentId: "eq-weather", alias: "rain_1h" },
    { equipmentId: "eq-gone", alias: "temperature" },
  ];

  it("sends the selection's values once, then only a value that changed, alone", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge, eqs } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(SELECTION));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")).toEqual([
      [
        { equipmentId: "eq-temp", alias: "temperature", value: 21.4, unit: "°C", measuredAt: ISO(NOW - 30_000) },
        { equipmentId: "eq-weather", alias: "rain_1h", value: 0.4, unit: "mm", measuredAt: ISO(NOW) },
      ],
    ]);
    // Re-reported by Sowel with the same value: nothing goes out.
    eqs.find((e) => e.id === "eq-temp")!.dataBindings![0].lastUpdated = ISO(NOW + 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(toBridge("home_readings")).toHaveLength(1);
    const temp = eqs.find((e) => e.id === "eq-temp")!.dataBindings![0];
    temp.value = 21.6;
    temp.lastUpdated = ISO(NOW + 4 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toBridge("home_readings")[1]).toEqual([
      { equipmentId: "eq-temp", alias: "temperature", value: 21.6, unit: "°C", measuredAt: ISO(NOW + 4 * 60_000) },
    ]);
    handle.stop();
  });

  it("resends a steady value an hour after its last send, so guestFlow knows Sowel still reports it", () => {
    const r = { equipmentId: "a", alias: "t", value: 20, unit: null, measuredAt: ISO(NOW + 59 * 60_000) };
    expect(hasChanged({ value: 20, measuredAt: ISO(NOW) }, r)).toBe(false);
    expect(hasChanged({ value: 20, measuredAt: ISO(NOW) }, { ...r, measuredAt: ISO(NOW + 60 * 60_000) })).toBe(true);
    expect(hasChanged({ value: 20, measuredAt: ISO(NOW) }, { ...r, value: 20.1 })).toBe(true);
    expect(hasChanged(undefined, r)).toBe(true);
  });

  it("retries a send that failed, and sends a pair selected again", async () => {
    vi.useFakeTimers({ now: NOW });
    let fail = true;
    const { ctx, setBridge, toBridge } = makeCtx({ failBridge: () => fail });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(SELECTION.slice(0, 1)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")).toHaveLength(0);
    fail = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toBridge("home_readings")).toHaveLength(1);
    setBridge("home_selection", "[]");
    await vi.advanceTimersByTimeAsync(2_000);
    setBridge("home_selection", JSON.stringify(SELECTION.slice(0, 1)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")).toHaveLength(2);
    handle.stop();
  });

  it("relays the day's min/max Sowel tracks, as readings of their own aliases", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge(
      "home_selection",
      JSON.stringify([
        { equipmentId: "eq-temp", alias: "temperature_min_today" },
        { equipmentId: "eq-temp", alias: "temperature_max_today" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")[0].map((r: { alias: string; value: number }) => [r.alias, r.value])).toEqual([
      ["temperature_min_today", 18.2],
      ["temperature_max_today", 22.9],
    ]);
    handle.stop();
  });

  it("sends nothing outside the catalogue: not the bridge, not an unshared sensor, not an unentrusted light, not an unknown alias", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge(
      "home_selection",
      JSON.stringify([
        { equipmentId: BRIDGE, alias: "home_command" },
        { equipmentId: "eq-pump", alias: "state" },
        { equipmentId: "eq-cave", alias: "temperature" },
        { equipmentId: "eq-hall", alias: "state" },
        { equipmentId: "eq-temp", alias: "secret" },
        { equipmentId: "eq-temp", alias: "humidity" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")).toEqual([
      [{ equipmentId: "eq-temp", alias: "humidity", value: 48, unit: "%", measuredAt: ISO(NOW - 30_000) }],
    ]);
    handle.stop();
  });
});

describe("series", () => {
  const hourly = [
    { equipmentId: "eq-meter", alias: "energy_hour" },
    { equipmentId: "eq-weather", alias: "rain_1h" },
    { equipmentId: "eq-cave", alias: "energy_hour" },
  ];

  it("come from Sowel's history once per hour, unchanged, on the binding Sowel historises", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-15T10:00:30Z") });
    const calls: { equipmentId: string; alias: string; from: string; to?: string; aggregation: string }[] = [];
    const history = {
      query: async (q: { equipmentId: string; alias: string; from: string; to?: string; aggregation: "1h" | "1d" }) => {
        calls.push(q);
        return {
          ok: true,
          points: [
            { time: "2026-11-15T08:00:00Z", value: 30 },
            { time: "2026-11-15T09:00:00Z", value: -5 },
            { time: "2026-11-15T10:00:00Z", value: 40, min: 1, max: 2 },
          ],
        };
      },
    };
    const { ctx, setBridge, toBridge } = makeCtx({ history });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly));
    await vi.advanceTimersByTimeAsync(2_000);
    // Spec 211 FR2: the running hour is never asked for — no `to`, complete hours only.
    expect(calls.map((c) => [c.equipmentId, c.alias, c.aggregation, c.from, c.to])).toEqual([
      ["eq-meter", "energy", "1h", "-24h", undefined],
      ["eq-weather", "rain_1h", "1h", "-24h", undefined],
    ]);
    const buckets = [
      { time: "2026-11-15T08:00:00Z", value: 30 },
      { time: "2026-11-15T10:00:00Z", value: 40 },
    ];
    expect(toBridge("home_series")).toEqual([
      [
        { equipmentId: "eq-meter", alias: "energy_hour", buckets },
        { equipmentId: "eq-weather", alias: "rain_1h", buckets },
      ],
    ]);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(toBridge("home_series")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000); // 11:00:32 — a new hour closed
    expect(toBridge("home_series")).toHaveLength(2);
    handle.stop();
  });

  it("are never estimated: without Sowel's history, none is sent", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge, logs } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly));
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(toBridge("home_series")).toEqual([]);
    expect(logs[0].message).toMatch(/sans historique Sowel/);
    handle.stop();
  });

  it("retry at the next tick when Sowel refuses a history read", async () => {
    vi.useFakeTimers({ now: NOW });
    let refuse = true;
    const history = {
      query: async () => {
        if (refuse) throw new Error("history rate limit");
        return { ok: true, points: [{ time: "2026-11-15T09:00:00Z", value: 1 }] };
      },
    };
    const { ctx, setBridge, toBridge, logs } = makeCtx({ history });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly.slice(0, 1)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_series")).toEqual([]);
    expect(logs.some((l) => l.level === "warn" && /history rate limit/.test(l.message))).toBe(true);
    refuse = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toBridge("home_series")).toHaveLength(1);
    handle.stop();
  });

  it("an outage (ok: false) sends nothing for that pair and is retried at the next tick; an empty answer is a series", async () => {
    vi.useFakeTimers({ now: NOW });
    let down = true;
    const asked: string[] = [];
    const history = {
      query: async (q: { equipmentId: string }) => {
        asked.push(q.equipmentId);
        if (q.equipmentId === "eq-meter") return down ? { ok: false, points: [] } : { ok: true, points: [{ time: "2026-11-15T09:00:00Z", value: 3 }] };
        return { ok: true, points: [] };
      },
    };
    const { ctx, setBridge, toBridge, logs } = makeCtx({ history });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly.slice(0, 2)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_series")).toEqual([]);
    expect(logs.some((l) => l.level === "warn" && /indisponible/.test(l.message))).toBe(true);
    down = false;
    asked.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    // The rain gauge answered « empty, ok » the first time: it is not asked again this hour.
    expect(asked).toEqual(["eq-meter"]);
    expect(toBridge("home_series")).toEqual([
      [{ equipmentId: "eq-meter", alias: "energy_hour", buckets: [{ time: "2026-11-15T09:00:00Z", value: 3 }] }],
    ]);
    handle.stop();
  });

  it("a rate refusal keeps what was read and resumes with the next pair at the next tick", async () => {
    vi.useFakeTimers({ now: NOW });
    const asked: string[] = [];
    let refuseWeather = true;
    const history = {
      query: async (q: { equipmentId: string }) => {
        asked.push(q.equipmentId);
        if (q.equipmentId === "eq-weather" && refuseWeather) throw new Error("history rate limit");
        return { ok: true, points: [{ time: "2026-11-15T09:00:00Z", value: q.equipmentId === "eq-meter" ? 5 : 0.2 }] };
      },
    };
    const { ctx, setBridge, toBridge } = makeCtx({ history });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly.slice(0, 2)));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(asked).toEqual(["eq-meter", "eq-weather"]);
    expect(toBridge("home_series")).toEqual([]);
    refuseWeather = false;
    asked.length = 0;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toEqual(["eq-weather"]);
    expect(toBridge("home_series")).toEqual([[
      { equipmentId: "eq-meter", alias: "energy_hour", buckets: [{ time: "2026-11-15T09:00:00Z", value: 5 }] },
      { equipmentId: "eq-weather", alias: "rain_1h", buckets: [{ time: "2026-11-15T09:00:00Z", value: 0.2 }] },
    ]]);
    handle.stop();
  });

  it("the history is read under ctx.helpers only: a `history` at the context's root is ignored", async () => {
    vi.useFakeTimers({ now: NOW });
    const query = vi.fn(async () => ({ ok: true, points: [{ time: "2026-11-15T09:00:00Z", value: 1 }] }));
    const { ctx, setBridge, toBridge } = makeCtx();
    (ctx as unknown as { history: unknown }).history = { query };
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify(hourly));
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(query).not.toHaveBeenCalled();
    expect(toBridge("home_series")).toEqual([]);
    handle.stop();
  });

  it("keep finite, non-negative points, 24 at most; read the binding named by the alias's category", () => {
    const pts = Array.from({ length: 30 }, (_, i) => ({ time: `t${i}`, value: i }));
    expect(bucketsOf(pts)).toHaveLength(24);
    expect(bucketsOf([{ time: "t", value: Number.NaN }, { time: "u", value: -1 }])).toEqual([]);
    const { eqs } = makeCtx();
    expect(historyAliasOf(eqs.find((e) => e.id === "eq-meter")!, "energy_hour")).toBe("energy");
    expect(historyAliasOf(eqs.find((e) => e.id === "eq-weather")!, "rain_1h")).toBe("rain_1h");
  });
});

describe("restored state", () => {
  it("drops whatever is not a list of times, and an hour-old entry", () => {
    expect(timesOf({ a: "x", b: [1, "2", 3], c: null })).toEqual({ b: [1, 3] });
    expect(timesOf([1, 2])).toEqual({});
    expect(pruneTimes({ a: [NOW - 3_600_000], b: [NOW - 10] }, NOW)).toEqual({ b: [NOW - 10] });
    expect(timeOf({ "1": NOW, "2": "x" })).toEqual({ "1": NOW });
  });
});

describe("commands", () => {
  it("never executes on the first read of the counter after a start, nor on a repeat or a lower value", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toHouse, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    // The counter already reads 100: re-publishing it, or lower, is no command.
    setBridge("home_command", JSON.stringify(cmd(1, "eq-lamp")));
    setBridge("home_command_seq", 100);
    setBridge("home_command_seq", 99);
    await flush();
    expect(toHouse()).toEqual([]);
    expect(toBridge("home_result")).toEqual([]);
    handle.stop();
  });

  it("ignores the first counter reading when the bridge had none at start", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, eqs, setBridge, toHouse } = makeCtx();
    eqs[0].dataBindings!.find((b) => b.alias === "home_command_seq")!.value = null;
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_command", JSON.stringify(cmd(1, "eq-lamp")));
    setBridge("home_command_seq", 500);
    await flush();
    expect(toHouse()).toEqual([]);
    setBridge("home_command_seq", 501);
    await flush();
    expect(toHouse()).toHaveLength(1);
    handle.stop();
  });

  it("drives an ON/OFF light and a boolean one, and reports ok", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, sendCommand, toHouse, toBridge, state } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    sendCommand(cmd(1, "eq-lamp", "on"));
    sendCommand(cmd(2, "eq-terrace", "on"));
    sendCommand(cmd(3, "eq-lamp", "off"));
    sendCommand(cmd(4, "eq-terrace", "off"));
    await flush();
    expect(toHouse()).toEqual([
      { equipmentId: "eq-lamp", alias: "state", value: "ON" },
      { equipmentId: "eq-terrace", alias: "state", value: true },
      { equipmentId: "eq-lamp", alias: "state", value: "OFF" },
      { equipmentId: "eq-terrace", alias: "state", value: false },
    ]);
    expect(toBridge("home_result")).toEqual([1, 2, 3, 4].map((id) => ({ id, ok: true })));
    expect(String(state.get("summary"))).toContain("4 commandes");
    handle.stop();
  });

  it("refuses a non-light, a light off the whitelist, a 61 s old command — reported, logged, nothing actuated", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, sendCommand, toHouse, toBridge, logs } = makeCtx();
    // eq-pump whitelisted by an older configuration: still no light, still refused.
    const handle = createRecipe().createInstance({ ...PARAMS, lights: [...PARAMS.lights, "eq-pump"] }, ctx);
    sendCommand(cmd(1, "eq-gate"));
    sendCommand(cmd(2, "eq-pump"));
    sendCommand(cmd(3, "eq-unknown"));
    sendCommand(cmd(4, "eq-hall"));
    sendCommand(cmd(5, "eq-lamp", "on", 61_000));
    sendCommand(cmd(6, "eq-lamp", "on", -61_000));
    sendCommand({ id: 7, propertyId: 1, equipmentId: "eq-lamp", value: "blink", issuedAt: ISO(NOW) });
    await flush();
    expect(toHouse()).toEqual([]);
    expect(toBridge("home_result")).toEqual([
      // The whitelist is checked first: a refusal says nothing about what an unknown id is.
      { id: 1, ok: false, reason: "not_entrusted" },
      { id: 2, ok: false, reason: "not_a_light" },
      { id: 3, ok: false, reason: "not_entrusted" },
      { id: 4, ok: false, reason: "not_entrusted" },
      { id: 5, ok: false, reason: "too_old" },
      { id: 6, ok: false, reason: "too_old" },
      { id: 7, ok: false, reason: "invalid_command" },
    ]);
    expect(logs.filter((l) => l.level === "warn").map((l) => l.message.match(/commande (\d+)/)?.[1])).toEqual([
      "1", "2", "3", "4", "5", "6", "7",
    ]);
    handle.stop();
  });

  it("refuses the 21st command of an hour for a light, whatever lodging guestFlow names, not another light's; an hour later it passes", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, sendCommand, toHouse, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    for (let i = 1; i <= 20; i += 1) sendCommand(cmd(i, "eq-lamp", i % 2 ? "on" : "off", 5_000, i));
    sendCommand(cmd(21, "eq-lamp", "on", 5_000, 99));
    sendCommand(cmd(22, "eq-terrace", "on"));
    await flush();
    expect(toHouse()).toHaveLength(21);
    expect(toBridge("home_result")[20]).toEqual({ id: 21, ok: false, reason: "rate_limited" });
    expect(toBridge("home_result")[21]).toEqual({ id: 22, ok: true });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    sendCommand(cmd(23, "eq-lamp"));
    await flush();
    expect(toBridge("home_result").at(-1)).toEqual({ id: 23, ok: true });
    handle.stop();
  });

  it("keeps the hourly count across a restart", async () => {
    vi.useFakeTimers({ now: NOW });
    const first = makeCtx();
    const h1 = createRecipe().createInstance(PARAMS, first.ctx);
    for (let i = 1; i <= 20; i += 1) first.sendCommand(cmd(i, "eq-lamp"));
    await flush();
    h1.stop();
    const second = makeCtx({ state: Object.fromEntries(first.state) });
    const h2 = createRecipe().createInstance(PARAMS, second.ctx);
    second.sendCommand(cmd(21, "eq-lamp"));
    await flush();
    expect(second.toBridge("home_result")).toEqual([{ id: 21, ok: false, reason: "rate_limited" }]);
    h2.stop();
  });

  it("acts on a command id once, whatever guestFlow resends", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, sendCommand, toHouse, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    sendCommand(cmd(1, "eq-lamp"));
    sendCommand(cmd(1, "eq-lamp"));
    await flush();
    expect(toHouse()).toHaveLength(1);
    expect(toBridge("home_result")).toEqual([{ id: 1, ok: true }]);
    handle.stop();
  });

  it("drives no order it cannot read as on/off", () => {
    const light = (o: Record<string, unknown>) => ({ id: "x", type: "light_onoff", orderBindings: [{ alias: "state", ...o }] });
    expect(lightOrder(light({ type: "number" }), "on")).toBeNull();
    expect(lightOrder(light({ type: "enum", enumValues: ["LOW", "HIGH"] }), "on")).toBeNull();
    expect(lightOrder(light({ type: "enum", enumValues: ["on", "off"] }), "off")).toEqual({ alias: "state", value: "off" });
  });

  it("reports order_failed when the light refuses, and never retries", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, sendCommand, toHouse, toBridge } = makeCtx({ failOrders: true });
    const handle = createRecipe().createInstance(PARAMS, ctx);
    sendCommand(cmd(1, "eq-lamp"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(toHouse()).toHaveLength(1);
    expect(toBridge("home_result")).toEqual([{ id: 1, ok: false, reason: "order_failed" }]);
    handle.stop();
  });

  it("stops listening and sending once stopped", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, handlers, orders } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    await flush();
    handle.stop();
    const sent = orders.length;
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(orders.length).toBe(sent);
    expect(handlers).toEqual([]);
  });
});
