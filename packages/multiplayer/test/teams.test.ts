import { describe, expect, it } from "vitest";
import { TickClient, type TickSnapshot } from "../src/index";
import { TickRoom, type HostedRoom, type TickRole } from "../src/server";
import { loopback } from "../src/testing";

/**
 * Team snapshots and spectators (D-127): a team's snapshot serialized once
 * for its players and the spectators watching it, put together with each
 * page's own `ack` and `cmd` by `t`; a spectator picks a team, or all.
 */

/** Players join a team ("red", "blue"); spectators join "watch:<team>" and switch by command. A team's score goes up by its players' commands. */
class Teams extends TickRoom<never, string> {
  readonly team = new Map<string, string>();
  readonly score = new Map<string, number>();
  readonly built: string[] = [];
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
  protected override teamOf(id: string): string | null {
    return this.team.get(id) ?? null;
  }
  protected override teamSnapshot(team: string): object {
    this.built.push(team);
    return team === "all" ? { team, score: Object.fromEntries(this.score) } : { team, score: this.score.get(team) ?? 0 };
  }
  protected override snapshot(id: string): object {
    return { me: id };
  }
}

type Snap = TickSnapshot & { team: string; score: number | Record<string, number>; me?: string };

describe("team snapshots and spectators (D-127)", () => {
  it("serializes a team's snapshot once for its players and its spectators, each with its own ack and cmd", () => {
    const broadcasts: { k: string; t: number; except: string[] }[] = [];
    const lb = loopback((room: HostedRoom) => {
      // count what goes out serialized once: the shared snapshot and each team's
      const broadcast = room.broadcast;
      room.broadcast = (data, except) => {
        const m = data as { k: string; t: number };
        broadcasts.push({ k: m.k, t: m.t, except: [...(except ?? [])].sort() });
        broadcast(data, except);
      };
      return new Teams(room, { clock: false, snapshotEvery: 3 });
    });
    const joins = ["red", "red", "blue", "watch:red", "watch:all"];
    const pages = joins.map(() => lb.join(0.05));
    const got: Snap[][] = pages.map(() => []);
    const clients = pages.map((p, n) => new TickClient<never, Snap>(p.room, { tick: 1 / 60, now: lb.now, restore: (s) => void got[n]!.push(s) }));
    clients.forEach((c, n) => c.hello(joins[n]));
    const frame = () => clients.forEach((c) => c.sync());
    lb.run(0.5, frame);

    // each snapshot tick: one serialization per team watched or played (red, blue, all), whatever the pages on it
    const t = broadcasts.findLast((b) => b.k === "team")!.t;
    const teams = broadcasts.filter((b) => b.k === "team" && b.t === t);
    expect(teams).toHaveLength(3);
    expect(lb.host.built.slice(-3).sort()).toEqual(["all", "blue", "red"]);
    // red's goes to its two players and its spectator only
    const red = teams.find((b) => b.except.length === 2)!;
    expect(red.except).toEqual([pages[2]!.room.id, pages[4]!.room.id].sort());

    // the red players restore red's view with their own ack and their own fields; the spectator red's without them
    const last = got.map((g) => g.at(-1)!);
    expect(last.map((s) => s.team)).toEqual(["red", "red", "blue", "red", "all"]);
    expect(last.map((s) => s.me)).toEqual(["1", "2", "3", undefined, undefined]);
    expect(last.every((s) => s.k === "snap" && s.ack === 0 && s.t === last[0]!.t)).toBe(true);

    // a red player's command: its own snapshot acknowledges it, red's view has it; its teammate's doesn't claim it
    const n = clients[1]!.command(5);
    lb.run(0.3, frame);
    const acked = got[1]!.find((s) => (s.cmd ?? 0) >= n)!;
    expect(acked.score).toBe(5);
    expect(got[0]!.at(-1)!.score).toBe(5);
    expect(got[0]!.at(-1)!.cmd).toBeUndefined();
    expect(got[4]!.at(-1)!.score).toEqual({ red: 5 });

    // the spectator switches to blue: acknowledged, and blue's view from that snapshot on
    const m = clients[3]!.command("blue");
    lb.run(0.3, frame);
    const switched = got[3]!.find((s) => (s.cmd ?? 0) >= m)!;
    expect(switched.team).toBe("blue");
    expect(got[3]!.at(-1)!.team).toBe("blue");
    expect(clients[3]!.ping).toBeGreaterThan(0);
    expect(lb.failed).toBeUndefined();
  });

  it("a room without teams sends as before: no team snapshot, and spectators get only the shared one", () => {
    class Plain extends Teams {
      protected override teamOf(): null {
        return null;
      }
    }
    const lb = loopback((room) => new Plain(room, { clock: false }));
    const [player, watcher] = [lb.join(), lb.join()];
    player.room.send({ k: "hello", join: "red" });
    watcher.room.send({ k: "hello", join: "watch:red" });
    lb.run(0.5);
    const kinds = (p: typeof player) => new Set(p.received.map((m) => (m as { k: string }).k));
    expect(kinds(player)).toEqual(new Set(["world", "snap"]));
    expect(kinds(watcher)).toEqual(new Set(["world"]));
    expect(lb.host.built).toEqual([]);
  });
});
