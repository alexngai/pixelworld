import { describe, expect, it } from "vitest";
import { Schema, TickClient, int, type TickSnapshot } from "../src/index";
import { TickRoom, type TickRole } from "../src/server";
import { loopback } from "../src/testing";

/**
 * A game run by commands alone (D-121): no inputs, numbered commands each
 * snapshot acknowledges, `sync` for a page with no vehicle of its own, and
 * ping from a command to the snapshot that has it.
 */

/** A tally per player that commands add to; no per-tick inputs. */
class Tally extends TickRoom<never, string> {
  readonly tally = new Map<string, number>();
  protected parseJoin(data: unknown): string | null {
    return typeof data === "string" ? data : null;
  }
  protected added(id: string): TickRole {
    this.tally.set(id, 0);
    return "player";
  }
  protected removed(id: string): void {
    this.tally.delete(id);
  }
  protected input(): null {
    return null;
  }
  protected step(): void {}
  protected override command(id: string, c: unknown): void {
    if (typeof c === "number") this.tally.set(id, this.tally.get(id)! + c);
  }
  protected override snapshot(id: string): object {
    return { tally: this.tally.get(id) };
  }
}

type Snap = TickSnapshot & { tally: number };

describe("commands acknowledged, for a page with no vehicle (D-121)", () => {
  it("numbers each command; the first snapshot that has it says so; sync puts it in place without inputs", () => {
    const lb = loopback((room) => new Tally(room, { clock: false, snapshotEvery: 3 }));
    const page = lb.join(0.05);
    const restored: Snap[] = [];
    const client = new TickClient<never, Snap>(page.room, { tick: 1 / 60, now: lb.now, restore: (s) => void restored.push(s) });
    client.hello("me");
    lb.run(0.2, () => client.sync());
    // no command yet: snapshots carry none, and ping waits
    expect(restored.at(-1)!.cmd).toBeUndefined();
    expect(client.ping).toBeNull();
    expect([client.command(2), client.command(3)]).toEqual([1, 2]);
    lb.run(0.3, () => client.sync());
    const first = restored.find((s) => s.cmd !== undefined)!;
    expect(first.cmd).toBe(2); // both arrived together and the next snapshot had both
    expect(first.tally).toBe(5);
    expect(first.ack).toBe(0); // no inputs, ever
    // 50 ms each way and up to a snapshot's wait (3 ticks)
    expect(client.ping).toBeGreaterThanOrEqual(100);
    expect(client.ping).toBeLessThan(160);
    // a burst of snapshots between frames: only the newest is put in place
    const before = restored.length;
    lb.run(0.25);
    client.sync();
    expect(restored.length).toBe(before + 1);
    expect(page.received.filter((m) => (m as { k: string }).k === "snap").length).toBeGreaterThan(before + 3);
  });

  it("an unnumbered command (an older page) is taken, and acknowledged by nothing", () => {
    const lb = loopback((room) => new Tally(room, { clock: false }));
    const page = lb.join(0.02);
    page.room.send({ k: "hello", join: "old" });
    page.room.send({ k: "cmd", c: 4 });
    page.room.send({ k: "cmd", c: 1, n: 1.5 });
    lb.run(0.3);
    const snaps = page.received.filter((m): m is Snap => (m as { k: string }).k === "snap");
    expect(snaps.at(-1)!.tally).toBe(5);
    expect(snaps.every((s) => s.cmd === undefined)).toBe(true);
  });

  it("binary snapshots (D-123) say the last command taken too", () => {
    const TALLY = new Schema<{ tally: number }>({ tally: int });
    class Binary extends Tally {
      protected override snapSchema = TALLY;
    }
    const lb = loopback((room) => new Binary(room, { clock: false, snapshotEvery: 3 }));
    const page = lb.join(0.05);
    const restored: Snap[] = [];
    const client = new TickClient<never, Snap>(page.room, { tick: 1 / 60, now: lb.now, snapSchema: TALLY, restore: (s) => void restored.push(s) });
    client.hello("me");
    lb.run(0.2, () => client.sync());
    expect(restored.at(-1)!.cmd).toBeUndefined();
    client.command(4);
    lb.run(0.3, () => client.sync());
    expect(restored.at(-1)).toMatchObject({ cmd: 1, tally: 4, ack: 0 });
    expect(page.received.some((m) => m instanceof Uint8Array)).toBe(true);
  });
});
