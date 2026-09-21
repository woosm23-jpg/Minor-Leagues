/**
 * Phase 0 empirical rating-axis fit.
 *
 * Baseball Savant publishes 2025 Statcast player percentile rankings across
 * hitter/pitcher metrics. THE CALL-UP uses that empirical rank space as the
 * common cross-tool reference, then maps percentile rank -> standard-normal
 * latent ability. Tool-specific raw metric -> Rating inference remains a later
 * importer/inverse-model responsibility; this file only freezes the shared
 * 20–99 ability axis used by the simulation engine.
 */
const ratingFit2025 = Object.freeze({
  id: "rating_fit_2025_statcast_percentile_v1",
  environment: "MLB 2025 completed regular season",
  retrievedForProject: "2026-09-18",
  source: Object.freeze({
    provider: "Baseball Savant / Statcast",
    name: "Statcast Percentile Rankings",
    hitterUrl:
      "https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=batter&year=2025",
    pitcherUrl:
      "https://baseballsavant.mlb.com/leaderboard/percentile-rankings?type=pitcher&year=2025",
    qualifierNote:
      "Savant leaderboard states 2.1 PA per team game for batters and 1.25 PA per team game for pitchers.",
    proxyCoverage: Object.freeze({
      hitter: Object.freeze([
        "xBA",
        "xSLG",
        "xISO",
        "Barrel%",
        "EV",
        "Max EV",
        "HardHit%",
        "K%",
        "BB%",
        "Whiff%",
        "Chase%",
        "Sprint Speed",
        "OAA",
        "Arm Strength",
        "Bat Speed",
        "Squared-up Rate"
      ]),
      pitcher: Object.freeze([
        "xwOBA",
        "xBA",
        "xSLG",
        "Barrel%",
        "EV allowed",
        "HardHit% allowed",
        "K%",
        "BB%",
        "Whiff%",
        "Chase%",
        "FB Velocity",
        "FB Spin"
      ])
    })
  }),
  method: Object.freeze({
    name: "empirical-percentile-to-normal-latent",
    description:
      "Map the GDD rating anchors to empirical MLB percentile ranks, then transform those ranks through the standard-normal inverse CDF. This makes Rating 50 exactly the MLB reference median (latent 0) and gives symmetric percentile meaning to ordinary ratings while preserving rare upper-tail ratings.",
    rawMetricPolicy:
      "Do not directly pool mph, percentages, OAA, and other incompatible raw units. Each future rating-inference model first estimates a tool-specific empirical percentile, then uses this shared axis.",
    topRatingPolicy:
      "Rating 99 is a deliberate post-anchor extrapolation to the 99.7th percentile so it remains rarer than the GDD 95~99th-percentile anchor. It is a project convention, not a Baseball Savant published threshold."
  }),
  anchors: Object.freeze([
    Object.freeze({ rating: 20, percentile: 0.01, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 30, percentile: 0.10, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 40, percentile: 0.25, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 50, percentile: 0.50, source: "GDD MLB reference" }),
    Object.freeze({ rating: 65, percentile: 0.75, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 80, percentile: 0.90, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 90, percentile: 0.97, source: "GDD percentile anchor" }),
    Object.freeze({ rating: 95, percentile: 0.99, source: "GDD percentile anchor" }),
    Object.freeze({
      rating: 99,
      percentile: 0.997,
      source: "Phase 0 rare-tail extrapolation",
      extrapolated: true
    })
  ])
});

export { ratingFit2025 };
