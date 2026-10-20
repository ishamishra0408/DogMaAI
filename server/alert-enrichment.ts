import Nimble from "@nimble-way/nimble-js";
import type { OwnerNotification, ResearchSource } from "../shared/api.js";
import { situationLabels, type Situation } from "../shared/domain.js";

export interface AlertContext {
  sessionId: string;
  situation: Situation;
  videoTimestamp: number;
}

export interface AlertEnricher {
  readonly mode: OwnerNotification["research_provider"];
  enrich(context: AlertContext): Promise<Pick<OwnerNotification, "message" | "research_summary" | "sources">>;
}

// Behaviour guidance from veterinary and animal-welfare organisations; the same sites bound the live search.
const guidanceDomains = ["aspca.org", "vcahospitals.com", "akc.org", "humanesociety.org"];
const fallbackSources: ResearchSource[] = [
  {
    title: "Separation Anxiety",
    url: "https://www.aspca.org/pet-care/dog-care/common-dog-behavior-issues/separation-anxiety",
    snippet: "Signs of separation anxiety and how to help, from the ASPCA."
  },
  {
    title: "Separation Anxiety in Dogs",
    url: "https://vcahospitals.com/know-your-pet/separation-anxiety-in-dogs",
    snippet: "A veterinary overview of causes and treatment from VCA Animal Hospitals."
  },
  {
    title: "Separation Anxiety in Dogs",
    url: "https://www.akc.org/expert-advice/training/separation-anxiety-in-dogs/",
    snippet: "Training approaches for dogs that struggle when left alone, from the American Kennel Club."
  }
];

function ownerMessage(context: AlertContext): string {
  const seconds = Math.round(context.videoTimestamp);
  return `DogMaAI saw "${situationLabels[context.situation.type].toLowerCase()}" for the alert period at ${seconds}s. Check on your dog; calm music from Comfort tools may help it settle. The links below are general guidance, not a diagnosis.`;
}

export class DemoSafetyResearchProvider implements AlertEnricher {
  readonly mode = "demo_fallback" as const;

  async enrich(context: AlertContext) {
    return {
      message: ownerMessage(context),
      research_summary: "Live Nimble search is not configured, so DogMaAI attached a small, preselected set of guidance from animal-welfare organisations.",
      sources: fallbackSources
    };
  }
}

export class NimbleSafetyResearchProvider implements AlertEnricher {
  readonly mode = "nimble_live" as const;
  private readonly client: Nimble;

  constructor(apiKey: string) {
    this.client = new Nimble({ apiKey });
  }

  async enrich(context: AlertContext) {
    const result = await this.client.search({
      query: `dog ${situationLabels[context.situation.type].toLowerCase()} when left home alone what owners can do`,
      include_domains: guidanceDomains,
      search_depth: "lite",
      max_results: 3,
      include_answer: true,
      country: "US",
      locale: "en"
    });
    const sources = result.results.slice(0, 3).map((item): ResearchSource => ({
      title: item.title,
      url: item.url,
      snippet: item.description.slice(0, 240)
    }));
    if (sources.length === 0) throw new Error("Nimble returned no vetted guidance sources");
    return {
      message: ownerMessage(context),
      research_summary: result.answer?.slice(0, 600) ?? "Nimble found current guidance from the vetted sources below.",
      sources
    };
  }
}

export function createAlertEnricher(): AlertEnricher {
  const apiKey = (process.env.NIMBLE_API_KEY ?? process.env.NIMBLE_API)?.trim();
  return apiKey ? new NimbleSafetyResearchProvider(apiKey) : new DemoSafetyResearchProvider();
}
