const CATEGORY_RULES = [
  { key: 'boss', weight: 18, hours: [0, 24], minMinutes: 12, maxMinutes: 28, match: /hunting|weekly|tactical hologram|boss|calamity/i },
  { key: 'tower', weight: 12, hours: [18, 2], minMinutes: 18, maxMinutes: 35, match: /tower|depths|illusive realm/i },
  { key: 'exploration', weight: 22, hours: [7, 23], minMinutes: 10, maxMinutes: 24, match: /exploring|jinzhou|firmament|forest|shores|huanglong|ragunna|reef|abyss/i },
  { key: 'event', weight: 15, hours: [10, 23], minMinutes: 8, maxMinutes: 20, match: /event|anniversary|challenge/i },
  { key: 'farming', weight: 33, hours: [0, 24], minMinutes: 7, maxMinutes: 18, match: /forgery|simulation|tuning|tacet|waveplates|echo|inventory|salvaging|daily|grinding|convene/i },
];

function inWindow(hour, [start, end]) {
  if (start === 0 && end === 24) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

function classify(text) {
  return CATEGORY_RULES.find((rule) => rule.match.test(text))?.key || 'farming';
}

function weightedPick(rules) {
  const total = rules.reduce((sum, rule) => sum + rule.weight, 0);
  let cursor = Math.random() * total;
  for (const rule of rules) {
    cursor -= rule.weight;
    if (cursor <= 0) return rule;
  }
  return rules[rules.length - 1];
}

function createPresenceEngine(pool, { minRotateMs = 10 * 60 * 1000, maxRotateMs = 20 * 60 * 1000 } = {}) {
  const entries = pool.map((text, index) => ({ text, index, category: classify(text) }));
  let lastIndex = -1;
  let lastCategory = null;

  function next(now = new Date()) {
    const hour = now.getHours();
    const availableRules = CATEGORY_RULES.filter((rule) => inWindow(hour, rule.hours));
    const category = weightedPick(availableRules.length ? availableRules : CATEGORY_RULES);
    let candidates = entries.filter((entry) => entry.category === category.key && entry.index !== lastIndex);
    if (!candidates.length) candidates = entries.filter((entry) => entry.index !== lastIndex);
    const selected = candidates[Math.floor(Math.random() * candidates.length)] || entries[0];
    lastIndex = selected.index;
    lastCategory = selected.category;
    const rule = CATEGORY_RULES.find((item) => item.key === selected.category) || CATEGORY_RULES[CATEGORY_RULES.length - 1];
    const durationMinutes = rule.minMinutes + Math.floor(Math.random() * (rule.maxMinutes - rule.minMinutes + 1));
    const delay = minRotateMs + Math.floor(Math.random() * (maxRotateMs - minRotateMs + 1));
    return { text: selected.text, category: lastCategory, durationMinutes, nextDelayMs: delay };
  }

  return { next, classify, categories: CATEGORY_RULES.map(({ key, weight, hours, minMinutes, maxMinutes }) => ({ key, weight, hours, minMinutes, maxMinutes })) };
}

module.exports = { createPresenceEngine, classify, CATEGORY_RULES };
