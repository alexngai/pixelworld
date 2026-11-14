import { describe, expect, it } from "vitest";
import { TickClient, type TickShared, type TickSnapshot } from "../src/index";
import { TickRoom, type HostedRoom, type TickRole } from "../src/server";
import { loopback } from "../src/testing";

/**
 * Teams and spectators on interest groups (D-127, over D-120's `groupOf`):
 * a team's view in its group's shared snapshot, serialized once for its
 * players and the spectators watching it; a spectator switching teams; and a
 * player's own snapshot, with the commands taken, after its team's of the
 * same time, so a page that shows an order at once knows the view has it.
 */

/** Players join a team ("red", "blue"); spectators "watch:<team>" and switch by command. A team's score goes up by its players' commands. */
class Teams extends TickRoom<never, string> {
  readonly team = new Map<string, string>();
  readonly score = new Map<string, number>();
  readonly built: (string | undefined)[] = [];
  protected parseJoin(data: unknown): string | null {
    return typeof data === "string" ? data : null;
  }
  protected added(id: string, join: string): TickRole {
    const watch = join.startsWith("watch:");
    this.team.set(id, watch ? join.slice(6) : join);
    return watch ? "spectator" : "player";
  }
  protected removed(id: string): void {
    this.team.delete(id);
  }
  protected input(): null {
    return null;
  }
  protected step(): void {}
  protected override command(id: string, c: unknown): void {
    const team = this.team.get(id)!;
    if (this.roleOf(id) === "spectator") this.team.set(id, String(c));
    else this.score.set(team, (this.score.get(team) ?? 0) + Number(c));
  }
  protected override groupOf(id: string): string | undefined {
    return this.team.get(id);
  }
  protected override shared(group?: string): object {
    this.built.push(group);
    return group ? { team: group, score: this.score.get(group) ?? 0 } : {};
  }
}

type View = TickShared & { team?: string; score?: number };

describe("teams and spectators on interest groups (D-127)", () => {
  it("a team's view once for its players and its watchers; a watcher switches; a player's taken command follows its team's view of the same time", () => {
    const sent: { k: string; to: string[] }[] = [];
    const lb = loopback((room: HostedRoom) => {
      const sendTo = room.sendTo!;
      room.sendTo = (ids, data) => {
        sent.push({ k: (data as { k: string }).k, to: [...ids].sort() });
        sendTo(ids, data);
      };
      return new Teams(room, { clock: false, snapshotEvery: 3 });
    });
    const joins = ["red", "red", "blue", "watch:red"];
    const pages = joins.map(() => lb.join(0.05));
    const views: View[][] = pages.map(() => []);
    const own: TickSnapshot[][] = pages.map(() => []);
    const clients = pages.map(
      (p, n) => new TickClient<never, object, View>(p.room, { tick: 1 / 60, now: lb.now, onWorld: (w) => void views[n]!.push(w), restore: (s) => void own[n]!.push(s) }),
    );
    clients.forEach((c, n) => c.hello(joins[n]));
    const frame = () => clients.forEach((c) => c.sync());
    lb.run(0.5, frame);

    // red's view goes once, to its two players and its watcher; blue's to its one
    const ids = pages.map((p) => p.room.id);
    const tick = sent.slice(-2).map((m) => m.to);
    expect(tick).toContainEqual([ids[0]!, ids[1]!, ids[3]!].sort());
    expect(tick).toContainEqual([ids[2]!]);
    expect(views.map((v) => v.at(-1)!.team)).toEqual(["red", "red", "blue", "red"]);
    expect(own[3]).toEqual([]); // a watcher has no snapshot of its own

    // a red player's command: the first snapshot of its own that has it, and red's view of that time has its effect
    const n = clients[1]!.command(5);
    lb.run(0.3, frame);
    const acked = own[1]!.find((s) => (s.cmd ?? 0) >= n)!;
    expect(views[1]!.find((v) => v.t === acked.t)!.score).toBe(5);
    expect(pages[1]!.received.findIndex((m) => (m as { k: string; t: number }).k === "world" && (m as { t: number }).t === acked.t)).toBeLessThan(
      pages[1]!.received.findIndex((m) => (m as { k: string; t: number }).k === "snap" && (m as { t: number }).t === acked.t),
    );
    expect(views[3]!.at(-1)!.score).toBe(5);
    expect(views[2]!.at(-1)!.score).toBe(0);

    // the watcher switches to blue
    clients[3]!.command("blue");
    lb.run(0.3, frame);
    expect(views[3]!.at(-1)!.team).toBe("blue");
    expect(sent.slice(-2).map((m) => m.to)).toContainEqual([ids[2]!, ids[3]!].sort());
    expect(lb.host.built.filter((g) => g === undefined)).toEqual([]); // every page in a group: no whole snapshot built
    expect(lb.failed).toBeUndefined();
  });
});
