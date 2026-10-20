export type DayPeriod = "morning" | "afternoon" | "evening" | "night";

// A free-license recording on Wikimedia Commons that Nimble found.
export interface FoundSound {
  id: string;
  title: string;
  artist: string;
  license: string;
  license_url: string | null;
  /** The Commons file page, which carries the full attribution. */
  page: string;
  duration_seconds: number;
  /** An MP3 where Commons has one, so every browser can preview it. */
  preview_url: string;
}

export interface SoundSearch {
  period: DayPeriod;
  label: string;
  query: string;
  sounds: FoundSound[];
  message: string;
}
