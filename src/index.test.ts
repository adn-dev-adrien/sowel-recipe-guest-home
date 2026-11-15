import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCatalog,
  createRecipe,
  keepSeries,
  lightOrder,
  pruneTimes,
  sampleHourly,
  timeOf,
  timesOf,
  type EquipmentDetails,
  type RecipeContext,
  type SeriesStore,
} from "./index.js";

// What these tests guard: the whitelist is the house's boundary. A command from
// guestFlow must never reach anything but an entrusted light — not on a
// restart, not on a repeated counter or id, not when stale, not beyond 20 an
// hour per light — and every refusal is reported. Values leave only for the
// selected pairs the catalogue describes.

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

function makeCtx(opts: { state?: Record<string, unknown>; failOrders?: boolean } = {}) {
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
      orders.push({ equipmentId, alias, value });
      if (opts.failOrders && equipmentId !== BRIDGE) return { success: false, error: "device offline" };
      return { success: true };
    },
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

const PARAMS = { zone: "root", bridge: BRIDGE, lights: ["eq-lamp", "eq-terrace"] };
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
    eqs[0].orderBindings = eqs[0].orderBindings!.filter((o) => o.alias !== "home_result");
    expect(() => recipe.validate(PARAMS, ctx)).toThrow(/home_result/);
  });

  it("declares the whitelist as a multi-select of light equipments", () => {
    const slot = createRecipe().slots.find((s) => s.id === "lights")!;
    expect(slot).toMatchObject({ type: "equipment", list: true });
    expect(slot.constraints?.equipmentType).toEqual(["light_onoff", "light_dimmable", "light_color", "switch"]);
  });
});

describe("the catalogue", () => {
  it("describes the catalogued types with zone path and readable values, no value, guestSwitchable exactly for the whitelist", () => {
    const { ctx } = makeCtx();
    const catalog = buildCatalog(ctx, new Set(PARAMS.lights), BRIDGE);
    // By zone path then name; the bridge, the pump (a switch that is no light) and the gate left out.
    expect(catalog.map((e) => e.id)).toEqual(["eq-weather", "eq-terrace", "eq-hall", "eq-lamp", "eq-temp"]);
    const byId = Object.fromEntries(catalog.map((e) => [e.id, e]));
    expect(byId["eq-temp"]).toEqual({
      id: "eq-temp",
      name: "Thermomètre salon",
      zonePath: "Gîte › Salon",
      type: "sensor",
      readings: [
        { alias: "temperature", category: "temperature", unit: "°C" },
        { alias: "humidity", category: "humidity", unit: "%" },
      ],
    });
    expect(byId["eq-weather"].readings).toContainEqual({ alias: "rain_1h", category: "rain", unit: "mm" });
    expect(byId["eq-lamp"].guestSwitchable).toBe(true);
    expect(byId["eq-terrace"].guestSwitchable).toBe(true);
    expect(byId["eq-hall"].guestSwitchable).toBe(false);
    expect(byId["eq-temp"]).not.toHaveProperty("guestSwitchable");
    expect(byId["eq-pump"]).toBeUndefined(); // a switch that is no light
    expect(byId["eq-gate"]).toBeUndefined();
    expect(JSON.stringify(catalog)).not.toMatch(/21\.4|"OFF"|0\.4/);
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
    handle.stop();
  });
});

describe("readings and series", () => {
  it("every 60 s, sends the selection's values only; a pair whose equipment is gone is skipped", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge(
      "home_selection",
      JSON.stringify([
        { equipmentId: "eq-temp", alias: "temperature" },
        { equipmentId: "eq-weather", alias: "rain_1h" },
        { equipmentId: "eq-gone", alias: "temperature" },
      ]),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    expect(toBridge("home_readings")).toEqual([
      [
        { equipmentId: "eq-temp", alias: "temperature", value: 21.4, unit: "°C", measuredAt: ISO(NOW - 30_000) },
        { equipmentId: "eq-weather", alias: "rain_1h", value: 0.4, unit: "mm", measuredAt: ISO(NOW) },
      ],
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(toBridge("home_readings")).toHaveLength(2);
    expect(JSON.stringify(toBridge("home_readings"))).not.toContain("humidity");
    handle.stop();
  });

  it("records the previous hour's value at each boundary, keeps 24 buckets, and sends them every 15 min", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-15T10:00:30Z") });
    const { ctx, setBridge, toBridge, eqs, state } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge("home_selection", JSON.stringify([{ equipmentId: "eq-weather", alias: "rain_1h" }]));
    const rain = eqs.find((e) => e.id === "eq-weather")!.computedData![0];
    rain.value = 1.2;
    await vi.advanceTimersByTimeAsync(59 * 60_000); // 10:59:30, last sample of the hour: 1.2
    rain.value = 0;
    await vi.advanceTimersByTimeAsync(60_000); // 11:00:30 — the 10:00 bucket closes
    expect((state.get("series") as SeriesStore).buckets["eq-weather|rain_1h"]).toEqual([
      { time: "2026-11-15T10:00:00.000Z", value: 1.2 },
    ]);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    const sent = toBridge("home_series");
    expect(sent.at(-1)).toEqual([
      { equipmentId: "eq-weather", alias: "rain_1h", buckets: [{ time: "2026-11-15T10:00:00.000Z", value: 1.2 }] },
    ]);
    handle.stop();
  });

  it("keeps a 24-bucket window, and a sample left from before a long stop makes no bucket", () => {
    let store: SeriesStore = { pending: {}, buckets: {} };
    const t0 = Date.parse("2026-11-14T00:10:00Z");
    for (let h = 0; h < 30; h += 1) store = sampleHourly(store, "k", h, t0 + h * 3_600_000);
    expect(store.buckets.k).toHaveLength(24);
    expect(store.buckets.k[23]).toEqual({ time: "2026-11-15T04:00:00.000Z", value: 28 });
    store = sampleHourly(store, "k", 5, t0 + 40 * 3_600_000);
    expect(store.buckets.k.at(-1)?.value).toBe(28);
    expect(store.buckets.k.length).toBeLessThan(24); // the window slid by 11 hours
  });

  it("sends nothing guestFlow selected outside the catalogue: not the bridge, not an uncatalogued equipment, not an unknown alias", async () => {
    vi.useFakeTimers({ now: NOW });
    const { ctx, setBridge, toBridge } = makeCtx();
    const handle = createRecipe().createInstance(PARAMS, ctx);
    setBridge(
      "home_selection",
      JSON.stringify([
        { equipmentId: BRIDGE, alias: "home_command" },
        { equipmentId: "eq-pump", alias: "state" },
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

  it("forgets the series of a pair no longer selected", () => {
    const store: SeriesStore = { pending: { a: { hour: 0, value: 1 }, b: { hour: 0, value: 2 } }, buckets: { a: [], b: [] } };
    expect(keepSeries(store, new Set(["a"]))).toEqual({ pending: { a: { hour: 0, value: 1 } }, buckets: { a: [] } });
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
