"""``evaluation.md``: generated from the computed metrics only, never edited by hand."""

from __future__ import annotations

from pathlib import Path
from typing import Any

MODEL_NAMES = {
    "baseline0": "Baseline 0: уровень confidence FIRMS",
    "baseline1": "Baseline 1: логистическая регрессия",
    "random_forest": "Random Forest (только сравнение)",
    "lightgbm": "LightGBM (кандидат)",
}
GATE_NAMES = {
    "pr_auc_above_baselines": "PR-AUC выше обоих baseline, нижняя граница 95 % ДИ разницы > 0",
    "brier_not_worse_than_baseline1": "Brier score не хуже baseline 1",
    "no_daynight_slice_below_baseline0": "На срезах день/ночь PR-AUC не ниже baseline 0",
    "lightgbm_best_on_validation": "LightGBM лучший по PR-AUC на validation",
    "report_generated": "Отчёт сгенерирован скриптом",
}


def _f(v: Any, digits: int = 3) -> str:
    return "—" if v is None else f"{v:.{digits}f}"


def _ci(ci: dict[str, list[float]], key: str) -> str:
    if key not in ci:
        return "—"
    lo, hi = ci[key]
    return f"[{lo:.3f}; {hi:.3f}]"


def write_report(path: Path, m: dict[str, Any], spec: dict[str, Any]) -> None:
    d = m["dataset"]
    lab = d["labels"]
    total = lab["positive"] + lab["negative"] + lab["ambiguous"]
    lines = [
        f"# Модель {m['name']} {m['version']}: отчёт об оценке",
        "",
        "Отчёт сгенерирован `firewatch_ml.train` автоматически. Все числа посчитаны на реальных",
        "данных NASA FIRMS и MCD64A1; заранее заявленных цифр нет.",
        "",
        f"**Решение: `{m['status']}`.** Обучено {m['trained_at']}, git `{m['git_sha'][:12]}`,"
        f" seed {m['seed']}.",
        "",
        "## 1. Постановка",
        "",
        "Бинарная классификация отдельного VIIRS-обнаружения: связано ли оно с гарью,",
        "независимо картированной MODIS Burned Area (MCD64A1 v6.1). Модель не подтверждает",
        "пожар и не прогнозирует пожары там, где обнаружений нет.",
        "",
        "## 2. Данные",
        "",
        f"- Объекты: {d['product']}, {d['objects_period'][0]} – {d['objects_period'][1]},"
        f" территория: {d['territory']}.",
        f"- Контекст для признаков с {d['context_from']} (архив NOAA-20 начинается 2018-04-01,"
        " поэтому признак постоянства в начале 2019 года видит меньше года истории).",
        f"- Метка: {d['label_rule']['source']}.",
        f"  - положительная: {d['label_rule']['positive']};",
        f"  - отрицательная: {d['label_rule']['negative']};",
        "  - остальное неоднозначно и исключено.",
        f"- Всего объектов {total:,}: положительных {lab['positive']:,},"
        f" отрицательных {lab['negative']:,}, неоднозначных {lab['ambiguous']:,}"
        f" ({lab['ambiguous'] / max(total, 1):.1%}; из них вода или нет данных MCD64A1:"
        f" {lab['unmapped_or_water']:,}).",
        f"- SHA-256 датасета: `{d['sha256']}`.",
        "",
        "| Год | Положительные | Отрицательные | Неоднозначные |",
        "|---|---|---|---|",
    ]
    for year, counts in sorted(d["by_year"].items()):
        lines.append(
            f"| {year} | {counts.get('1', 0):,} | {counts.get('0', 0):,}"
            f" | {counts.get('-1', 0):,} |"
        )
    s = m["splits"]
    lines += [
        "",
        "## 3. Разделение",
        "",
        "| Выборка | Годы | Объектов | Доля положительных |",
        "|---|---|---|---|",
    ]
    for key, label in (("train", "train"), ("val", "validation"), ("test", "test")):
        first, last = s[key]
        years = str(first) if first == last else f"{first}–{last}"
        lines.append(
            f"| {label} | {years} | {s['sizes'][key]:,} | {s['positive_share'][key]:.3f} |"
        )
    lines += [
        "",
        "Гиперпараметры LightGBM подбирались GroupKFold (k = 5) по ячейкам 1°×1° только внутри",
        "train. Validation использовался для ранней остановки, калибровки (isotonic) и порогов.",
        "Test оценён один раз.",
        "",
        "| num_leaves | min_child_samples | CV PR-AUC | σ | Деревьев (среднее) |",
        "|---|---|---|---|---|",
    ]
    for r in m["cv"]:
        lines.append(
            f"| {r['num_leaves']} | {r['min_child_samples']} | {_f(r['cv_pr_auc'])} |"
            f" {_f(r['cv_pr_auc_std'])} | {r['mean_rounds']:.0f} |"
        )
    lines += [
        "",
        f"Выбрано: num_leaves = {m['params']['num_leaves']},"
        f" min_child_samples = {m['params']['min_child_samples']},"
        f" деревьев после ранней остановки: {m['params']['best_iteration']}.",
        "",
        "## 4. Сравнение моделей",
        "",
        "Все вероятности откалиброваны isotonic-регрессией на validation. 95 % ДИ: бутстрап по",
        "приближённым очагам (ячейка ~2 км × 3 суток), 1000 повторов.",
        "",
        "| Модель | PR-AUC (val) | PR-AUC (test) | 95 % ДИ | ROC-AUC (test) | Brier (test) |",
        "|---|---|---|---|---|---|",
    ]
    ci = m["test_ci95"]
    for key, name in MODEL_NAMES.items():
        t = m["test"][key]
        lines.append(
            f"| {name} | {_f(m['validation_pr_auc'][key])} | {_f(t['pr_auc'])} |"
            f" {_ci(ci, key + '.pr_auc')} | {_f(t['roc_auc'])} | {_f(t['brier'], 4)} |"
        )
    lines += [
        "",
        f"Разница PR-AUC LightGBM − baseline 0: 95 % ДИ {_ci(ci, 'diff_vs_baseline0.pr_auc')}.",
        f"Разница PR-AUC LightGBM − baseline 1: 95 % ДИ {_ci(ci, 'diff_vs_baseline1.pr_auc')}.",
        "",
        "## 5. Срезы (test, PR-AUC)",
        "",
        "| Срез | Объектов | Доля положительных | LightGBM | Baseline 0 | Baseline 1 |",
        "|---|---|---|---|---|---|",
    ]
    for key, v in m["slices"].items():
        lines.append(
            f"| {key} | {v['n']:,} | {v['positive_share']:.3f} | {_f(v['lightgbm'])} |"
            f" {_f(v['baseline0'])} | {_f(v['baseline1'])} |"
        )
    lines += [
        "",
        "Срез по спутнику не строится: обучение и тест только на NOAA-20.",
        "",
        "## 6. Уровни риска",
        "",
        "Пороги выбраны на validation по целевой точности (very_high ≥ 0,9; high ≥ 0,75;",
        "moderate ≥ 0,5; не менее 50 объектов). Если цель недостижима, уровень не присваивается.",
        "",
        "| Уровень | Порог | Объектов (val) | Точность (val) | Объектов (test) | Точность (test) |",
        "|---|---|---|---|---|---|",
    ]
    for level, v in m["levels"].items():
        lines.append(
            f"| {level} | {_f(v['threshold'], 4)} | {v['val_n']:,} | {_f(v['val_precision'])} |"
            f" {v['test_n']:,} | {_f(v['test_precision'])} |"
        )
    lines += [
        "",
        "## 7. Калибровка (test, децили вероятности)",
        "",
        "| Объектов | Средняя вероятность | Наблюдаемая доля |",
        "|---|---|---|",
    ]
    lines += [
        f"| {r['n']:,} | {_f(r['mean_p'])} | {_f(r['observed'])} |" for r in m["calibration_table"]
    ]
    lines += [
        "",
        "## 8. Вклад признаков (среднее |SHAP|, 20 000 объектов test)",
        "",
        "| Признак | Вклад |",
        "|---|---|",
    ]
    lines += [f"| `{k}` | {v:.4f} |" for k, v in m["importance"].items()]
    lines += [
        "",
        "## 9. Критерии допуска (ML_STRATEGY §8)",
        "",
        "| Критерий | Выполнен |",
        "|---|---|",
    ]
    lines += [f"| {GATE_NAMES[k]} | {'да' if v else '**нет**'} |" for k, v in m["gate"].items()]
    lines += [
        "",
        "## 10. Ограничения",
        "",
        "- Признаки погоды не используются: архив Open-Meteo по всем ячейкам за 7 лет не",
        "  помещается в бесплатный суточный лимит. Это кандидат на версию 1.1.",
        "- Обучение только на VIIRS NOAA-20. В работе модель применяется к VIIRS NOAA-20 и",
        "  NOAA-21 (тот же прибор); MODIS не оценивается. Контекстные признаки всегда считаются",
        f"  по {spec['context_satellite']}: при перебоях NOAA-20 они занижаются.",
        "- Метка MCD64A1 (500 м) пропускает мелкие пожары, они попадают в отрицательный или",
        "  неоднозначный класс. Сельхозпалы — реальные растительные пожары и считаются",
        "  положительными. MCD64A1 частично использует MODIS active fire.",
        "- Очаги для бутстрапа приближены сеткой ~2 км × 3 суток, а не DBSCAN.",
        "- Координаты не используются как признаки, но признак постоянства источника может",
        "  переносить знание о конкретных местах (так и задумано для факелов).",
        "",
        "## 11. Воспроизводимость",
        "",
        "```",
        "python -m firewatch_ml.data --start 2018-04-01 --end 2025-12-31",
        "python -m firewatch_ml.build_dataset --start 2019-01-01 --end 2025-12-31",
        "python -m firewatch_ml.train",
        "python -m firewatch_ml.register",
        "```",
        "",
        f"Артефакт: `{m['artifact']['path']}`, SHA-256 `{m['artifact']['sha256']}`.",
        "Версии: " + ", ".join(f"{k} {v}" for k, v in m["libraries"].items()) + ".",
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
