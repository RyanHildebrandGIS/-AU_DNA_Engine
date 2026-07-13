/**
 * The utility domains the Design and Cost panels both offer. Shared so a new
 * utility type only needs to be added in one place to show up consistently
 * in the network-generation type selector and the cost-rate template rows.
 */
export type UtilityType = "water" | "sewer" | "stormwater" | "electric" | "fiber";

export const UTILITY_TYPES: UtilityType[] = [
  "water",
  "sewer",
  "stormwater",
  "electric",
  "fiber",
];
