import type { ComfortStat, Idea, MusicStat, Source, Tip } from "../shared/analytics.js";

// Every source below was checked to exist, and each tip only repeats what its page says.
const sources = {
  aspcaSeparation: { name: "ASPCA · Separation anxiety", url: "https://www.aspca.org/pet-care/dog-care/common-dog-behavior-issues/separation-anxiety" },
  akcSleep: { name: "AKC · Why do dogs sleep so much", url: "https://www.akc.org/expert-advice/health/why-do-dogs-sleep-so-much/" },
  akcBed: { name: "AKC · Why your pup needs a good bed", url: "https://www.akc.org/expert-advice/health/choosing-right-dog-bed/" },
  bowmanMusic: { name: "Bowman et al. 2017 · Music genres and kennelled dogs", url: "https://pubmed.ncbi.nlm.nih.gov/28093218/" },
  akcSnuffle: { name: "AKC · Snuffle mats", url: "https://www.akc.org/expert-advice/lifestyle/snuffle-mats-for-dogs/" },
  akcScent: { name: "AKC · Indoor scent games", url: "https://www.akc.org/expert-advice/training/indoor-scent-games-for-dogs/" },
  akcDiyToys: { name: "AKC · DIY brain toys", url: "https://www.akc.org/expert-advice/lifestyle/do-it-yourself-cognitive-dog-toys-for-home/" },
  akcBrainGames: { name: "AKC · Brain games for dogs", url: "https://www.akc.org/expert-advice/training/fun-cognitive-training-games-for-dogs/" },
  aspcaDiy: { name: "ASPCA · Canine DIY enrichment", url: "https://www.aspca.org/pet-care/dog-care/canine-diy-enrichment" },
  aspcaRecipes: { name: "ASPCA · Enrichment recipes", url: "https://www.aspca.org/pet-care/dog-care/enrichment-recipes" },
  vcaFeeders: { name: "VCA · Interactive feeders", url: "https://vcahospitals.com/know-your-pet/feeding-the-mind-and-body-interactive-feeders-for-dogs-and-cats" },
  vcaToys: { name: "VCA · Enrichment and activity toys", url: "https://vcahospitals.com/know-your-pet/behavior-management---enrichment-and-activity-toys" }
} satisfies Record<string, Source>;

export interface AdviceFacts {
  dogName: string;
  watchedHours: number;
  activeShare: number | null;
  alone: { minutes: number; restless: number | null; door: number | null };
  naps: { perDay: number | null; longest: number };
  comfort: ComfortStat[];
  /** How many stretches alone seemed calm, unsettled or upset, and the usual minutes to settle. */
  feelings: { calm: number; unsettled: number; upset: number; typicalSettle: number | null };
  /** Minutes of crying while alone, per complete day the microphone was heard. */
  crying: { minutesPerDay: number | null };
  music: MusicStat;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;
// The name may be the default "your dog", so a sentence that opens with it gets a capital.
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const points = (difference: number) => `${Math.round(Math.abs(difference) * 100)} points`;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function chooseTips(facts: AdviceFacts): Tip[] {
  const name = facts.dogName;
  const Name = capital(name);
  const tips: Tip[] = [];
  const { alone, naps, feelings, crying, music } = facts;
  const stretches = feelings.calm + feelings.unsettled + feelings.upset;
  if (feelings.upset >= 2) tips.push({
    id: "upset", title: "Talk to your vet about time alone",
    why: `${Name} seemed upset in ${feelings.upset} of the ${stretches} stretches alone the camera could judge. The ASPCA advises ruling out a medical cause first, and getting help from a qualified behaviour professional when separation distress is more than mild.`,
    source: sources.aspcaSeparation
  });
  if (crying.minutesPerDay !== null && crying.minutesPerDay >= 3) tips.push({
    id: "crying", title: `Help ${name} feel safe alone`,
    why: `${Name} cried for about ${Math.round(crying.minutesPerDay)} minutes a day while alone. The ASPCA suggests linking your leaving with something good, such as a food puzzle that only appears when you go, and keeping goodbyes and hellos calm and low-key.`,
    source: sources.aspcaSeparation
  });
  if (alone.minutes >= 60 && alone.door !== null && alone.door >= 0.1) tips.push({
    id: "door", title: "Keep goodbyes calm and short",
    why: `${Name} spent ${percent(alone.door)} of alone time at the door. The ASPCA suggests staying calm and quiet when you go out and come in, and practising absences that start at a second or two and slowly grow.`,
    source: sources.aspcaSeparation
  });
  if (alone.minutes >= 60 && alone.restless !== null && alone.restless >= 0.3) tips.push({
    id: "restless", title: "Exercise right before you leave",
    why: `${Name} was up and moving for ${percent(alone.restless)} of alone time. The ASPCA suggests exercising your dog right before leaving, and a food-stuffed puzzle toy that takes 20 to 30 minutes as you go.`,
    source: sources.aspcaSeparation
  });
  // Music is judged from whole stretches alone once there are enough of them, and otherwise from the minutes around each sound.
  const withMusic = music.with_music; const withoutMusic = music.without_music;
  if (music.verdict === "helped") tips.push({
    id: "music", title: `Music seems to help ${name}`,
    why: `With music, ${name} settled in about ${withMusic.settle_minutes} minutes when alone, against ${withoutMusic.settle_minutes} without${withMusic.crying_per_hour !== null && withoutMusic.crying_per_hour !== null ? `, and cried ${withMusic.crying_per_hour} against ${withoutMusic.crying_per_hour} minutes an hour` : ""}. Bowman and colleagues suggest varying what plays so dogs do not get used to it.`,
    source: sources.bowmanMusic
  });
  else if (music.verdict === "worse" || music.verdict === "no_difference") tips.push({
    id: "music", title: music.verdict === "worse" ? "Try something other than music" : "Music has not made a clear difference yet",
    why: `${Name} settled in about ${withMusic.settle_minutes} minutes with music and ${withoutMusic.settle_minutes} without. Dogs respond to sounds differently, and Bowman and colleagues found variety worth trying.`,
    source: sources.bowmanMusic
  });
  else for (const sound of facts.comfort.filter(item => item.plays >= 2)) {
    const change = sound.active_after - sound.active_before;
    if (change <= -0.1) tips.push({
      id: `sound-${sound.sound}`, title: `${sound.sound} seems to settle ${name}`,
      why: `In the 15 minutes after ${sound.sound.toLowerCase()} started, ${name} was active ${points(change)} less than before (${plural(sound.plays, "play")}). Bowman and colleagues suggest varying what plays so dogs do not get used to it.`,
      source: sources.bowmanMusic
    });
    else if (change >= 0.05) tips.push({
      id: `sound-${sound.sound}`, title: `Try something other than ${sound.sound.toLowerCase()}`,
      why: `After ${sound.sound.toLowerCase()} started, ${name} was active ${points(change)} more than before (${plural(sound.plays, "play")}). Dogs respond to sounds differently, and Bowman and colleagues found variety worth trying.`,
      source: sources.bowmanMusic
    });
  }
  if (facts.watchedHours >= 3 && facts.activeShare !== null && facts.activeShare < 0.1) tips.push({
    id: "activity", title: "Add a daily play or brain game",
    why: `${Name} was active for ${percent(facts.activeShare)} of the time DogMaAI watched. AKC notes dogs spend about 20% of the day being active, so a short game can help round out the day.`,
    source: sources.akcSleep
  });
  if (naps.perDay !== null && naps.perDay >= 6 && naps.longest < 30) tips.push({
    id: "naps", title: "Offer a quiet, cosy bed",
    why: `${Name} took about ${Math.round(naps.perDay)} short naps a day, the longest ${naps.longest} minutes. AKC explains why a good bed matters for sound sleep.`,
    source: sources.akcBed
  });
  if (!tips.length) tips.push({
    id: "steady", title: "A nice, steady rhythm",
    why: `Nothing stood out in ${name}'s week. For comparison, AKC notes dogs tend to spend about half the day asleep, 30% awake but relaxing and 20% active.`,
    source: sources.akcSleep
  });
  return tips.slice(0, 5);
}

type Need = "crying" | "door" | "restless" | "low" | "alone" | "general";
const catalogue: { id: string; title: string; how: string; needs: Need[]; source: Source }[] = [
  { id: "frozen", title: "A frozen stuffed toy for goodbyes", how: "Stuff a toy with part of a meal, freeze it, and hand it over as you leave.", needs: ["crying", "door", "restless", "alone"], source: sources.aspcaRecipes },
  { id: "feeder", title: "A puzzle feeder for time alone", how: "Leave a snack in an interactive feeder so it takes a while and keeps the brain busy.", needs: ["crying", "alone"], source: sources.vcaFeeders },
  { id: "snuffle", title: "A snuffle mat hunt", how: "Scatter some kibble in a snuffle mat so snack time becomes a sniffing hunt.", needs: ["restless", "low"], source: sources.akcSnuffle },
  { id: "scent", title: "Indoor scent games", how: "Hide a few treats around a room and cheer while they are sniffed out.", needs: ["low", "restless"], source: sources.akcScent },
  { id: "muffin", title: "Muffin-tin puzzle", how: "Put treats in a muffin tin and cover each cup with a tennis ball.", needs: ["alone", "low"], source: sources.akcDiyToys },
  { id: "brain", title: "Two-minute brain games", how: "Short thinking games tire the mind as well as the body.", needs: ["low"], source: sources.akcBrainGames },
  { id: "cardboard", title: "Cardboard box forage", how: "Crumple treats into paper in a box and let the shredding begin.", needs: ["low", "general"], source: sources.aspcaDiy },
  { id: "toys", title: "Activity toys for quiet time", how: "Offer a food-dispensing or chew toy for the hours spent alone.", needs: ["alone", "general"], source: sources.vcaToys }
];

export function chooseIdeas(facts: AdviceFacts): Idea[] {
  const name = facts.dogName;
  const Name = capital(name);
  const weight: Record<Need, number> = { crying: 0, door: 0, restless: 0, low: 0, alone: 0, general: 0.5 };
  // Two wordings for each reason, so two cards can share one without repeating a sentence.
  const because: Record<Need, [string, string]> = {
    crying: [`${Name} cries when left alone.`, "Something to look forward to when you go."],
    door: [`${Name} waits at the door when alone.`, "Something better to do than watch the door."],
    restless: [`${Name} is often up and about when alone.`, "A job for a busy mind while you are out."],
    low: [`${Name} could use a little more activity.`, "A little extra movement for the day."],
    alone: [`For the hours ${name} spends alone.`, "Something to do while you are out."],
    general: [`A simple way to keep ${name} curious.`, "Easy to set up at home."]
  };
  if (facts.crying.minutesPerDay !== null && facts.crying.minutesPerDay >= 3) weight.crying = 3;
  if (facts.alone.door !== null && facts.alone.door >= 0.1) weight.door = 3;
  if (facts.alone.restless !== null && facts.alone.restless >= 0.3) weight.restless = 2;
  if (facts.alone.minutes >= 60) weight.alone = 1;
  if (facts.activeShare !== null && facts.activeShare < 0.12) weight.low = 2;
  // A card gives a reason only when the week's data supports it, and each wording only once.
  const used: Record<Need, number> = { crying: 0, door: 0, restless: 0, low: 0, alone: 0, general: 0 };
  return catalogue
    .map((idea, order) => ({ idea, order, score: idea.needs.reduce((sum, need) => sum + weight[need], 0) }))
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .slice(0, 4)
    .map(({ idea }) => {
      const need = idea.needs.filter(item => weight[item] > 0 && used[item] < 2).sort((left, right) => weight[right] - weight[left])[0];
      const reason = need ? because[need][used[need]++] : null;
      return { id: idea.id, title: idea.title, how: idea.how, because: reason, source: idea.source };
    });
}
