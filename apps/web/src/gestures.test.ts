import { describe, expect, it } from "vitest";
import { GestureDebouncer } from "./gestures";

const feed = (d: GestureDebouncer, frames: [string | undefined, number, number?][], t0 = 0, dt = 1 / 15) =>
  frames.map(([n, s, x], i) => d.push(n, s, x, t0 + i * dt)).filter(Boolean);

describe("GestureDebouncer", () => {
  it("fires once a gesture is held, and only once while it is held", () => {
    const d = new GestureDebouncer();
    expect(feed(d, Array.from({ length: 30 }, () => ["Thumb_Up", 0.9, 0.5] as [string, number, number]))).toEqual(["thumbs_up"]);
  });
  it("ignores flickers, low confidence and 'None'", () => {
    const d = new GestureDebouncer();
    const frames: [string | undefined, number, number?][] = [];
    for (let i = 0; i < 30; i++) frames.push(i % 2 ? ["Victory", 0.9] : ["None", 0.9]);
    for (let i = 0; i < 20; i++) frames.push(["ILoveYou", 0.3]);
    expect(feed(d, frames)).toEqual([]);
  });
  it("an open hand swinging side to side is a wave; held still it is a stop sign", () => {
    const d = new GestureDebouncer();
    const xs = [0.4, 0.46, 0.52, 0.46, 0.4, 0.46, 0.52, 0.46, 0.4, 0.46];
    expect(feed(d, xs.map((x) => ["Open_Palm", 0.9, x] as [string, number, number]))).toEqual(["wave"]);
    const d2 = new GestureDebouncer();
    expect(feed(d2, Array.from({ length: 12 }, () => ["Open_Palm", 0.9, 0.5] as [string, number, number]))).toEqual(["open_palm"]);
  });
  it("holding a gesture counts once, however long; lowering the hand re-arms it", () => {
    const d = new GestureDebouncer();
    const thumbs = (n: number, t0: number) => feed(d, Array.from({ length: n }, () => ["Thumb_Up", 0.9, 0.5] as [string, number, number]), t0);
    expect(thumbs(150, 0)).toEqual(["thumbs_up"]); // 10 s held
    expect(feed(d, Array.from({ length: 8 }, () => ["None", 0.9] as [string, number]), 10)).toEqual([]); // hand down
    expect(thumbs(10, 11)).toEqual(["thumbs_up"]);
  });
  it("respects the cooldown between quick repetitions", () => {
    const d = new GestureDebouncer();
    expect(feed(d, Array.from({ length: 10 }, () => ["Thumb_Up", 0.9, 0.5] as [string, number, number]), 0)).toEqual(["thumbs_up"]);
    feed(d, Array.from({ length: 6 }, () => ["None", 0.9] as [string, number]), 0.7);
    expect(feed(d, Array.from({ length: 10 }, () => ["Thumb_Up", 0.9, 0.5] as [string, number, number]), 1.2)).toEqual([]);
  });
  it("switching to another gesture while holding the first one works", () => {
    const d = new GestureDebouncer();
    const frames = [...Array.from({ length: 30 }, () => ["Thumb_Up", 0.9, 0.5]), ...Array.from({ length: 12 }, () => ["Victory", 0.9, 0.5])] as [string, number, number][];
    expect(feed(d, frames)).toEqual(["thumbs_up", "victory"]);
  });
});
