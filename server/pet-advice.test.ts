import { describe, expect, it } from "vitest";
import { chooseIdeas, chooseTips, type AdviceFacts } from "./pet-advice.js";

// A calm week with nothing to flag, for the default name used when DOG_NAME is not set.
const noMusic = { episodes: 0, settle_minutes: null, crying_per_hour: null, upset: 0 };
const facts = (change: Partial<AdviceFacts> = {}): AdviceFacts => ({
  dogName: "your dog", watchedHours: 40, activeShare: 0.25,
  alone: { minutes: 600, restless: 0.12, door: 0.03 },
  naps: { perDay: 6, longest: 120 },
  comfort: [],
  feelings: { calm: 5, unsettled: 1, upset: 0, typicalSettle: 12 },
  crying: { minutesPerDay: 0.5 },
  music: { plays: 0, with_music: noMusic, without_music: noMusic, verdict: "not_enough" },
  ...change
});

describe("Pawrent tips and ideas", () => {
  it("gives the steady note only when nothing else stood out, and capitalises a name that opens a sentence", () => {
    expect(chooseTips(facts()).map(tip => tip.id)).toEqual(["steady"]);
    const tips = chooseTips(facts({ alone: { minutes: 600, restless: 0.4, door: 0.2 } }));
    expect(tips.map(tip => tip.id)).toEqual(["door", "restless"]);
    expect(tips[0].why).toMatch(/^Your dog spent 20% of alone time at the door\./);
  });

  it("speaks up about crying and repeated upset when alone, with the ASPCA's advice", () => {
    const tips = chooseTips(facts({ feelings: { calm: 3, unsettled: 1, upset: 2, typicalSettle: 30 }, crying: { minutesPerDay: 6.4 } }));
    expect(tips.map(tip => tip.id)).toEqual(["upset", "crying"]);
    expect(tips[0].why).toContain("Your dog seemed upset in 2 of the 6 stretches alone the camera could judge.");
    expect(tips[1]).toMatchObject({ title: "Help your dog feel safe alone" });
    expect(tips[1].why).toContain("about 6 minutes a day while alone");
    expect(tips.every(tip => tip.source.url.includes("aspca.org"))).toBe(true);
  });

  it("says whether music helped once there are enough stretches alone to compare", () => {
    const helped = chooseTips(facts({ music: { plays: 3, with_music: { episodes: 3, settle_minutes: 10, crying_per_hour: 0.2, upset: 0 }, without_music: { episodes: 2, settle_minutes: 28, crying_per_hour: 1.5, upset: 1 }, verdict: "helped" } }));
    expect(helped[0]).toMatchObject({ id: "music", title: "Music seems to help your dog" });
    expect(helped[0].why).toContain("settled in about 10 minutes when alone, against 28 without");
  });

  it("gives an idea a reason only when the week's data supports it, and never the same sentence twice", () => {
    const ideas = chooseIdeas(facts());
    expect(ideas.map(idea => idea.id)).toEqual(["toys", "frozen", "feeder", "muffin"]);
    expect(ideas.map(idea => idea.because)).toEqual(["For the hours your dog spends alone.", "Something to do while you are out.", null, null]);
    // Crying when alone puts the goodbye ideas first.
    expect(chooseIdeas(facts({ crying: { minutesPerDay: 5 } })).slice(0, 2).map(idea => [idea.id, idea.because])).toEqual([["frozen", "Your dog cries when left alone."], ["feeder", "Something to look forward to when you go."]]);
    // Little time alone and ordinary activity: nothing supports a claim about the door or being alone.
    const quiet = chooseIdeas(facts({ alone: { minutes: 30, restless: null, door: null } }));
    expect(quiet.map(idea => idea.because)).toEqual(["A simple way to keep your dog curious.", "Easy to set up at home.", null, null]);
  });
});
