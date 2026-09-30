// Справочные таблицы допусков (ГОСТ 25347-82), взяты из присланного преподавателем PDF
// "Задания_по_квалитетам.pdf", плюс набор вариантов заданий из "Задания.xlsx".
// В отличие от заданий по чертежам, здесь правильный ответ ВЫЧИСЛЯЕТСЯ по формуле —
// поэтому проверка полностью автоматическая, без участия преподавателя.

// Границы интервалов номинальных размеров (мм). Первый интервал включает обе границы,
// остальные — «свыше..до», т.е. нижняя граница исключается.
const RANGES = [
  [3, 6], [6, 10], [10, 18], [18, 30], [30, 50], [50, 80], [80, 120]
];

function rangeIndex(nominal) {
  for (let i = 0; i < RANGES.length; i++) {
    const [lo, hi] = RANGES[i];
    if (i === 0 ? (nominal >= lo && nominal <= hi) : (nominal > lo && nominal <= hi)) return i;
  }
  return -1;
}

// [ES/es, EI/ei] в мкм, по интервалам RANGES, для каждого поля допуска.
const HOLE_FIELDS = {
  H7: [[12, 0], [15, 0], [18, 0], [21, 0], [25, 0], [30, 0], [35, 0]],
  H8: [[18, 0], [22, 0], [27, 0], [33, 0], [39, 0], [46, 0], [54, 0]],
  JS7: [[6, -6], [7.5, -7.5], [9, -9], [10.5, -10.5], [12.5, -12.5], [15, -15], [17.5, -17.5]],
  E9: [[50, 20], [61, 25], [75, 32], [92, 40], [112, 50], [134, 60], [159, 72]]
};

const SHAFT_FIELDS = {
  h6: [[0, -8], [0, -9], [0, -11], [0, -13], [0, -16], [0, -19], [0, -22]],
  h7: [[0, -12], [0, -15], [0, -18], [0, -21], [0, -25], [0, -30], [0, -35]],
  f7: [[-10, -22], [-13, -28], [-16, -34], [-20, -41], [-25, -50], [-30, -60], [-36, -71]],
  js6: [[4, -4], [4.5, -4.5], [5.5, -5.5], [6.5, -6.5], [8, -8], [9.5, -9.5], [11, -11]]
};

// Считает правильный ответ по варианту { kind: 'hole'|'shaft', nominal, field }.
// Возвращает null, если размер вне покрытых таблицей интервалов (3–120 мм) или поле неизвестно.
function computeAnswer(variant) {
  const table = variant.kind === 'hole' ? HOLE_FIELDS : SHAFT_FIELDS;
  const row = table[variant.field];
  if (!row) return null;
  const idx = rangeIndex(variant.nominal);
  if (idx === -1) return null;
  const [devMaxUm, devMinUm] = row[idx];
  const devMaxMm = devMaxUm / 1000;
  const devMinMm = devMinUm / 1000;
  return {
    devMaxUm, devMinUm, devMaxMm, devMinMm,
    limMaxMm: +(variant.nominal + devMaxMm).toFixed(4),
    limMinMm: +(variant.nominal + devMinMm).toFixed(4)
  };
}

const SEED_TOLERANCE_TASK = {
  id: 'tolerance-fits-v1',
  title: 'Расчёт предельных отклонений и размеров (квалитеты)',
  intro: 'По таблице допусков ГОСТ 25347-82 определите отклонения и рассчитайте предельные размеры для вашего варианта.',
  variants: [
    { kind: 'hole', nominal: 30, field: 'H7' },
    { kind: 'shaft', nominal: 50, field: 'h6' },
    { kind: 'hole', nominal: 10, field: 'JS7' },
    { kind: 'shaft', nominal: 20, field: 'f7' },
    { kind: 'hole', nominal: 80, field: 'E9' },
    { kind: 'shaft', nominal: 40, field: 'js6' },
    { kind: 'hole', nominal: 25, field: 'H7' },
    { kind: 'shaft', nominal: 12, field: 'h6' },
    { kind: 'hole', nominal: 65, field: 'H8' },
    { kind: 'shaft', nominal: 8, field: 'f7' },
    { kind: 'hole', nominal: 16, field: 'JS7' },
    { kind: 'shaft', nominal: 30, field: 'js6' },
    { kind: 'hole', nominal: 100, field: 'E9' },
    { kind: 'shaft', nominal: 45, field: 'h7' },
    { kind: 'hole', nominal: 5, field: 'H7' },
    { kind: 'shaft', nominal: 70, field: 'f7' },
    { kind: 'hole', nominal: 5, field: 'H8' },
    { kind: 'hole', nominal: 15, field: 'JS7' },
    { kind: 'hole', nominal: 65, field: 'H7' },
    { kind: 'shaft', nominal: 8, field: 'h7' },
    { kind: 'shaft', nominal: 35, field: 'f7' },
    { kind: 'shaft', nominal: 75, field: 'js6' }
  ].map((v, i) => ({ id: 'v' + (i + 1), ...v }))
};

module.exports = { RANGES, HOLE_FIELDS, SHAFT_FIELDS, rangeIndex, computeAnswer, SEED_TOLERANCE_TASK };
