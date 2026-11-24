import { describe, expect, it } from "vitest";
import { Ahead } from "../src/ahead";

/** Fights made ahead (D-185), with makes that finish when told. */
describe("fights made ahead", () => {
  const rig = () => {
    const log: string[] = [];
    const finish = new Map<number, () => void>();
    const dropped: number[] = [];
    const ahead = new Ahead<number>(
      (site) => {
        log.push(`make ${site}`);
        return new Promise((done) => finish.set(site, () => done(site)));
      },
      (site) => dropped.push(site),
    );
    const tick = () => new Promise((r) => setTimeout(r, 0));
    return { log, finish, dropped, ahead, tick };
  };

  it("makes the wanted sites one at a time, and a taken one is ready", async () => {
    const { log, finish, ahead, tick, dropped } = rig();
    ahead.want([3, 5, 7]);
    await tick();
    expect(log).toEqual(["make 3"]);
    finish.get(3)!();
    await tick();
    expect(log).toEqual(["make 3", "make 5"]);
    expect(await ahead.take(3)).toBe(3);
    // the one being made is let go when it's done, and nothing more is made
    finish.get(5)!();
    await tick();
    expect(dropped).toEqual([5]);
    expect(log).toEqual(["make 3", "make 5"]);
  });

  it("makes a taken site next, after the one being made, never two at once", async () => {
    const { log, finish, ahead, tick, dropped } = rig();
    ahead.want([1, 2]);
    await tick();
    const taken = ahead.take(9);
    ahead.want([4]);
    await tick();
    expect(log).toEqual(["make 1"]);
    finish.get(1)!();
    await tick();
    expect(log).toEqual(["make 1", "make 9"]);
    finish.get(9)!();
    expect(await taken).toBe(9);
    await tick();
    expect(log).toEqual(["make 1", "make 9", "make 4"]);
    expect(dropped).toEqual([1]);
  });
});
