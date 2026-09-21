function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function first(row, keys) { for (const key of keys) if (row?.[key] != null && row[key] !== "") return row[key]; return null; }
function percentile(row, keys) { const value = finite(first(row, keys)); return value == null ? null : Math.max(0, Math.min(100, value)); }

/**
 * Merge Baseball Savant percentile-export rows into existing public hitting/pitching stat values.
 * This adapter stores only public evidence. It never creates game ratings or hidden ceilings.
 */
export function mergeStatcastPercentilesIntoStats(stats, rows, { season } = {}) {
  const normalized = new Map();
  for (const row of rows ?? []) {
    const playerId = String(first(row,["player_id","playerId","id"]) ?? "");
    if (!playerId) continue;
    normalized.set(playerId, {
      xBAPercentile: percentile(row,["xba_percentile","xBA_percentile","xba"]),
      xISOPercentile: percentile(row,["xiso_percentile","xISO_percentile","xiso"]),
      maxEVPercentile: percentile(row,["max_ev_percentile","maxEV_percentile","max_ev"]),
      barrelPercentile: percentile(row,["barrel_percentile","brl_percentile","barrel"]),
      whiffPercentile: percentile(row,["whiff_percentile","whiff"]),
      chasePercentile: percentile(row,["chase_percentile","chase"]),
      sprintSpeedPercentile: percentile(row,["sprint_speed_percentile","sprint_percentile","sprint_speed"]),
      oaaPercentile: percentile(row,["oaa_percentile","oaa"]),
      armStrengthPercentile: percentile(row,["arm_strength_percentile","arm_percentile","arm_strength"]),
      fastballVelocityPercentile: percentile(row,["fb_velocity_percentile","fastball_velocity_percentile","fb_velocity"]),
      hardHitAllowedPercentile: percentile(row,["hard_hit_percentile","hardhit_percentile"]),
      barrelAllowedPercentile: percentile(row,["barrel_allowed_percentile","barrel_percentile"])
    });
  }
  return (stats ?? []).map((stat) => {
    if (season != null && Number(stat.season) !== Number(season)) return stat;
    const extra = normalized.get(String(stat.playerId));
    if (!extra || !["hitting","pitching","fielding"].includes(stat.group)) return stat;
    const values = { ...(stat.values ?? {}) };
    for (const [key,value] of Object.entries(extra)) if (value != null) values[key] = value;
    return { ...stat, values };
  });
}
