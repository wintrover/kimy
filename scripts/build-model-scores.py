#!/usr/bin/env python3
"""ETL script to build NVIDIA provider model benchmark scores from HF Open LLM Leaderboard.

Reads ~/.kimi-code/config.toml to discover all nvidia models, matches them against
the `open-llm-leaderboard/results` dataset, and produces 3-tier benchmark scores:

  - Tier 1 (direct): model found in leaderboard → use its geometric mean score.
  - Tier 2 (proxy): model not found directly → look up a proxy HF model via a
    truth table and copy that proxy's score.
  - Tier 3 (param estimate): no direct or proxy match → estimate from parameter
    count extracted from the model name, capped at a ceiling derived from Tier 1.

Non-LLM models (embedding, safety, rerank, protein-folding, etc.) are purged.
"""

import argparse
import json
import math
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import tomllib
except ImportError:
    print(
        "Error: Python 3.11+ is required (tomllib is not available).",
        file=sys.stderr,
    )
    sys.exit(1)

try:
    from huggingface_hub import HfApi, hf_hub_download
except ImportError:
    print(
        "Error: the `huggingface_hub` library is not installed.\n"
        "Install it with:  pip install huggingface_hub\n"
        "or, in this repo: pnpm exec nix develop  # provides it via flake.nix",
        file=sys.stderr,
    )
    sys.exit(1)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

# Keywords in a model id that indicate a non-LLM model to be purged.
PURGED_KEYWORDS = (
    "embedding",
    "embed",
    "bge",
    "nv-embed",
    "safety",
    "content-safety",
    "safety-guard",
    "rerank",
    "reranker",
    "voicechat",
    "studiovoice",
    "voice",
    "sparsedrive",
    "bevformer",
    "streampetr",
    "esmfold",
    "esm2",
    "gliner",
    "pii",
    "translate",
    "riva-translate",
    "usdcode",
    "paligemma",
    "llama-guard",
)

# Common prefixes/suffixes to strip when doing partial matching.
STRIP_PREFIXES = (
    "nvidia/",
    "meta/",
    "google/",
    "microsoft/",
    "mistralai/",
    "openai/",
    "deepseek-ai/",
    "qwen/",
    "moonshotai/",
    "z-ai/",
    "bytedance/",
    "stepfun-ai/",
    "minimaxai/",
    "upstage/",
    "sarvamai/",
    "abacusai/",
)
STRIP_SUFFIXES = (
    "-instruct",
    "-chat",
    "-it",
    "-base",
    "-v0.1",
    "-v0.2",
    "-v0.3",
    "-v1",
    "-v2",
    "-v3",
)

# Commercial models that must NOT fall to Tier 3 (require proxy mapping).
COMMERCIAL_KEYWORDS = (
    "kimi",
    "minimax",
    "stepfun",
    "step-3",
    "glm",
    "gpt-oss",
    "seed-oss",
    "sarvam",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def is_purged(model_id: str) -> bool:
    """Return True if `model_id` looks like a non-LLM specialized model."""
    lowered = model_id.lower()
    return any(kw in lowered for kw in PURGED_KEYWORDS)


def normalize_for_match(model_id: str) -> str:
    """Lowercase and strip common prefixes/suffixes for fuzzy matching."""
    lowered = model_id.lower()
    for prefix in STRIP_PREFIXES:
        if lowered.startswith(prefix):
            lowered = lowered[len(prefix) :]
            break
    for suffix in STRIP_SUFFIXES:
        if lowered.endswith(suffix):
            lowered = lowered[: -len(suffix)]
            break
    return lowered


def parse_params_billions(model_id: str) -> float | None:
    """Extract parameter count in billions from model ID. Returns None if unparseable.

    Handles:
      - MoE patterns like "8x7b" → 8*7 = 56B total
      - Dense patterns like "8b", "2.5b", "70b"
    """
    # MoE pattern: e.g. "8x7b" → 8*7 = 56B total
    moe_match = re.search(r"(?i)(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*b", model_id)
    if moe_match:
        experts = int(moe_match.group(1))
        per_expert = float(moe_match.group(2))
        return experts * per_expert

    # Dense pattern: e.g. "8b", "2.5b", "70b"
    dense_match = re.search(r"(?i)\b(\d+(?:\.\d+)?)\s*b\b", model_id)
    if dense_match:
        return float(dense_match.group(1))

    return None


def geometric_mean(values: list[float]) -> float:
    """Compute geometric mean of a list of positive values."""
    if not values:
        return 0.0
    log_sum = sum(math.log(v) for v in values if v > 0)
    count = sum(1 for v in values if v > 0)
    if count == 0:
        return 0.0
    return math.exp(log_sum / count)


# ---------------------------------------------------------------------------
# Config parsing
# ---------------------------------------------------------------------------


def load_nvidia_models(config_path: Path) -> dict:
    """Parse config.toml and return {alias: model_info} for nvidia models."""
    with open(config_path, "rb") as f:
        config = tomllib.load(f)

    models_section = config.get("models", {})
    nvidia_models: dict[str, dict] = {}
    for alias, info in models_section.items():
        if not alias.startswith("nvidia/"):
            continue
        if not isinstance(info, dict):
            continue
        provider = info.get("provider")
        if provider != "nvidia":
            continue
        nvidia_models[alias] = {
            "model": info.get("model", ""),
            "display_name": info.get("display_name", ""),
            "capabilities": info.get("capabilities", []),
        }
    return nvidia_models


# ---------------------------------------------------------------------------
# Leaderboard loading & matching
# ---------------------------------------------------------------------------


def extract_leaderboard_scores(leaderboard: dict) -> list[float]:
    """Extract all numeric benchmark scores from a leaderboard dict.

    The leaderboard dict has keys like 'leaderboard_musr', 'leaderboard_math_hard',
    'leaderboard_bbh', 'leaderboard_mmlu_pro', etc. Each value is a dict of
    sub-scores with keys like 'prompt_level_loose_acc,none', 'exact_match,none',
    'acc_norm,none', 'acc,none'.

    We extract all numeric values that are not stderr.
    """
    scores: list[float] = []

    def _extract(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                # Skip stderr keys
                if "stderr" in k.lower() or "std" in k.lower():
                    continue
                if isinstance(v, (int, float)):
                    scores.append(float(v))
                elif isinstance(v, dict):
                    _extract(v)
                elif isinstance(v, list):
                    for item in v:
                        _extract(item)
        elif isinstance(obj, (int, float)):
            scores.append(float(obj))

    _extract(leaderboard)
    return scores


def build_leaderboard_index_from_hub(
    model_ids: list[str],
    truth_table: dict[str, str],
) -> dict[str, float]:
    """Build leaderboard scores by targeted download from HF Hub.

    Instead of streaming the entire dataset, we:
    1. List all files in the dataset repo
    2. Filter to JSON files matching our target model keywords
    3. Download only matched files
    4. Parse for model_name + leaderboard scores → geometric mean
    """
    api = HfApi()

    # Step 1: List all files in the dataset
    print("Listing files in open-llm-leaderboard/results...", file=sys.stderr)
    all_files = api.list_repo_files(
        repo_id="open-llm-leaderboard/results",
        repo_type="dataset",
    )
    print(f"  Total files in repo: {len(all_files)}", file=sys.stderr)

    # Step 2: Build precise directory prefixes for the models we need.
    # Files live at `org-Model-Name/results_timestamp.json` in the dataset.
    # Loose keyword matching (e.g. "qwen", "instruct") catches hundreds of files and makes download prohibitively slow. Instead we match
    # on the normalized directory prefix (org/model).
    target_dirs: set[str] = set()

    def _add_model(model_id: str):
        lowered = model_id.lower()
        if lowered.startswith("nvidia/"):
            lowered = lowered[len("nvidia/"):]
        # Strip common org prefixes to build candidate directory names
        # (the leaderboard sometimes uses a different org alias).
        bare = lowered.split("/", 1)[1] if "/" in lowered else lowered
        target_dirs.add(lowered)                 # e.g. "qwen/qwen2.5-72b-instruct"
        target_dirs.add(bare)                    # e.g. "qwen2.5-72b-instruct"

    for mid in model_ids:
        _add_model(mid)
    for proxy_id in truth_table.values():
        _add_model(proxy_id)

    # Step 3: Filter files — match the file's directory prefix exactly.
    matched_files = []
    for f in all_files:
        if not f.endswith(".json"):
            continue
        # The directory is everything before the last "/"
        f_dir = f.rsplit("/", 1)[0].lower() if "/" in f else f.lower()
        if f_dir in target_dirs:
            matched_files.append(f)
            continue
        # Also accept files whose directory ends with a known bare model name
        # (handles org aliasing, e.g. config uses "qwen" but dataset has "Qwen2.5").
        for d in target_dirs:
            if "/" in d and f_dir == d:
                matched_files.append(f)
                break

    print(f"  Target directories: {len(target_dirs)}", file=sys.stderr)
    print(f"  Matched {len(matched_files)} JSON files for target models.", file=sys.stderr)

    if not matched_files:
        print("  WARNING: No matched files found. Trying broader search...", file=sys.stderr)
        # Fallback: try to find any JSON files with results
        json_files = [f for f in all_files if f.endswith(".json") and "results" in f.lower()]
        if json_files:
            matched_files = json_files[:100]  # Limit
            print(f"  Fallback: using {len(matched_files)} 'results' JSON files.", file=sys.stderr)

    # Step 4: Download and parse matched files
    scores: dict[str, float] = {}
    for filepath in matched_files:
        try:
            local_path = hf_hub_download(
                repo_id="open-llm-leaderboard/results",
                filename=filepath,
                repo_type="dataset",
            )
            with open(local_path) as f:
                data = json.load(f)

            # Try to extract model_name and leaderboard from the JSON
            # The structure may vary — try common patterns
            model_name = None
            leaderboard = None

            if isinstance(data, dict):
                model_name = data.get("model_name") or data.get("model")
                leaderboard = data.get("leaderboard") or data.get("results")

                # If the JSON contains multiple results (array)
                if isinstance(data, list):
                    for entry in data:
                        if isinstance(entry, dict):
                            mn = entry.get("model_name") or entry.get("model")
                            lb = entry.get("leaderboard") or entry.get("results")
                            if mn and lb:
                                all_scores = extract_leaderboard_scores(lb)
                                if all_scores:
                                    scores[mn.lower()] = geometric_mean(all_scores)
                    continue

                if model_name and leaderboard and isinstance(leaderboard, dict):
                    all_scores = extract_leaderboard_scores(leaderboard)
                    if all_scores:
                        scores[model_name.lower()] = geometric_mean(all_scores)
        except Exception as e:
            print(f"  Warning: failed to parse {filepath}: {e}", file=sys.stderr)
            continue

    print(f"  Extracted scores for {len(scores)} models.", file=sys.stderr)
    return scores


def match_model_tier1(
    model_id: str,
    leaderboard_scores: dict[str, float],
) -> str | None:
    """Try to match a config model id against the leaderboard index (Tier 1).

    Returns the matched key if found, None otherwise.
    """
    lowered = model_id.lower()

    # 1) Exact match
    if lowered in leaderboard_scores:
        return lowered

    # 2) Normalized match: strip prefixes/suffixes
    normalized = normalize_for_match(model_id)
    for key in leaderboard_scores:
        key_normalized = normalize_for_match(key)
        if normalized == key_normalized:
            return key

    # 3) Known-family heuristics: e.g. llama-3.1-70b → llama-3.1-70b-instruct
    for suffix in ("-instruct", "-instruct-0905", "-instruct-2512"):
        candidate = lowered + suffix
        if candidate in leaderboard_scores:
            return candidate

    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Build NVIDIA model benchmark scores from HF leaderboard data."
    )
    parser.add_argument(
        "--config",
        type=str,
        default=str(Path.home() / ".kimi-code/config.toml"),
        help="Path to config.toml (default: ~/.kimi-code/config.toml).",
    )
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(
            Path(__file__).resolve().parents[1] / "apps" / "kimi-code" / "src" / "tui" / "data"
        ),
        help="Directory for output JSON files.",
    )
    parser.add_argument(
        "--truth-table",
        type=str,
        default=None,
        help="Path to model-truth-table.json (default: <output_dir>/model-truth-table.json).",
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # --- Load truth table ---
    if args.truth_table:
        truth_table_path = Path(args.truth_table)
    else:
        truth_table_path = output_dir / "model-truth-table.json"

    truth_table: dict[str, str] = {}
    if truth_table_path.exists():
        with open(truth_table_path) as f:
            truth_table = json.load(f)
        print(f"Loaded truth table with {len(truth_table)} entries from {truth_table_path}", file=sys.stderr)
    else:
        print(f"Warning: truth table not found at {truth_table_path}, Tier 2 disabled.", file=sys.stderr)

    # --- Discover nvidia models from config ---
    print(f"Loading nvidia models from {config_path}...", file=sys.stderr)
    if not config_path.exists():
        print(f"Error: config file not found: {config_path}", file=sys.stderr)
        sys.exit(1)

    nvidia_models = load_nvidia_models(config_path)
    print(f"  Found {len(nvidia_models)} nvidia model entries.", file=sys.stderr)

    # --- Partition into chat-LLM vs purged ---
    chat_models: dict[str, dict] = {}
    purged_models: list[str] = []
    for alias, info in nvidia_models.items():
        model_id = info["model"]
        if is_purged(model_id) or is_purged(alias):
            purged_models.append(alias)
        else:
            chat_models[alias] = info

    print(
        f"  Chat/LLM models: {len(chat_models)}, purged: {len(purged_models)}.",
        file=sys.stderr,
    )

    # --- Load leaderboard results dataset ---
    leaderboard_scores = build_leaderboard_index_from_hub(
        list(chat_models.keys()), truth_table
    )

    # --- Match models using 3-tier cascade ---
    scores: dict[str, float] = {}
    model_tiers: dict[str, int] = {}
    id_mapping: dict[str, str] = {}  # nvidia/alias → HF display name
    proxy_sources: dict[str, str] = {}  # HF-model-id → proxy-HF-model-id
    unmatched: list[str] = []

    # Phase 1: Tier 1 (direct match)
    tier1_keys: dict[str, str] = {}  # alias → matched leaderboard key
    for alias, info in chat_models.items():
        model_id = info["model"]
        matched_key = match_model_tier1(model_id, leaderboard_scores)
        if matched_key is not None:
            tier1_keys[alias] = matched_key
            hf_name = matched_key  # Use the leaderboard key as the canonical name
            id_mapping[alias] = hf_name
            scores[hf_name] = leaderboard_scores[matched_key]
            model_tiers[hf_name] = 1

    print(f"  Tier 1 matches: {len(tier1_keys)}", file=sys.stderr)

    # Phase 2: Tier 2 (proxy anchoring via truth table)
    tier2_keys: dict[str, str] = {}  # alias → proxy HF model id
    for alias, info in chat_models.items():
        if alias in tier1_keys:
            continue
        # Look up alias in truth table
        proxy_hf_id = truth_table.get(alias)
        if proxy_hf_id is None:
            continue
        proxy_key = proxy_hf_id.lower()
        if proxy_key in leaderboard_scores:
            tier2_keys[alias] = proxy_key
            id_mapping[alias] = proxy_key
            scores[proxy_key] = leaderboard_scores[proxy_key]
            model_tiers[proxy_key] = 2
            proxy_sources[proxy_key] = proxy_hf_id

    print(f"  Tier 2 matches: {len(tier2_keys)}", file=sys.stderr)

    # Phase 3: Tier 3 (parameter estimation with ceiling)
    # Compute Tier 3 ceiling from Tier 1 median
    tier1_score_values = [scores[k] for k, v in model_tiers.items() if v == 1]
    if tier1_score_values:
        tier1_median = statistics.median(tier1_score_values)
        tier3_ceiling = tier1_median * 0.9
    else:
        tier3_ceiling = 0.5  # fallback if no Tier 1 scores exist

    # Find max params among Tier 3 candidates for log normalization
    tier3_candidates: dict[str, float] = {}  # alias → params in billions
    for alias, info in chat_models.items():
        if alias in tier1_keys or alias in tier2_keys:
            continue
        model_id = info["model"]
        params = parse_params_billions(model_id)
        if params is not None and params > 0:
            tier3_candidates[alias] = params

    max_params = max(tier3_candidates.values()) if tier3_candidates else 1.0
    log_max = math.log10(max_params) if max_params > 0 else 1.0
    tier1_avg = sum(tier1_score_values) / len(tier1_score_values) if tier1_score_values else 0.5

    for alias, params in tier3_candidates.items():
        model_id = chat_models[alias]["model"]
        if log_max > 0:
            raw_score = tier1_avg * (math.log10(params) / log_max)
        else:
            raw_score = tier1_avg * 0.5
        final_score = min(raw_score, tier3_ceiling)
        scores[model_id] = round(final_score, 4)
        model_tiers[model_id] = 3
        id_mapping[alias] = model_id

    # Remaining unmatched (no params parseable)
    for alias, info in chat_models.items():
        if alias in tier1_keys or alias in tier2_keys:
            continue
        if alias not in tier3_candidates:
            unmatched.append(alias)
            print(
                f"  Warning: no leaderboard match for {alias} (model={info['model']})",
                file=sys.stderr,
            )

    print(f"  Tier 3 estimates: {len(tier3_candidates)}", file=sys.stderr)
    print(f"  Tier 3 ceiling: {tier3_ceiling:.4f}", file=sys.stderr)

    # --- Commercial model validation assertion ---
    for alias, info in chat_models.items():
        model_id = info["model"].lower()
        alias_lower = alias.lower()
        is_commercial = any(kw in model_id or kw in alias_lower for kw in COMMERCIAL_KEYWORDS)
        if is_commercial:
            # Determine the key used in model_tiers
            tier = model_tiers.get(model_id) or model_tiers.get(info.get("display_name", "").lower())
            if tier == 3:
                print(
                    f"ERROR: Commercial model {alias} fell to Tier 3 — missing proxy mapping!",
                    file=sys.stderr,
                )
                sys.exit(1)

    # --- Write outputs ---
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    mapping_path = output_dir / "model-id-mapping.json"
    with open(mapping_path, "w") as f:
        json.dump(id_mapping, f, indent=2, sort_keys=True)
    print(f"Wrote {len(id_mapping)} mappings to {mapping_path}", file=sys.stderr)

    benchmark_output = {
        "metadata": {
            "generatedAt": now,
            "source": "open-llm-leaderboard/results",
            "version": "3.0.0",
            "tier1Count": len(tier1_keys),
            "tier2Count": len(tier2_keys),
            "tier3Count": len(tier3_candidates),
            "purgedCount": len(purged_models),
            "tier3Ceiling": round(tier3_ceiling, 4),
        },
        "scores": scores,
        "modelTiers": model_tiers,
        "proxySources": proxy_sources,
        "purgedModels": sorted(purged_models),
    }

    scores_path = output_dir / "model-benchmark-scores.json"
    with open(scores_path, "w") as f:
        json.dump(benchmark_output, f, indent=2, sort_keys=True)
    print(
        f"Wrote {len(scores)} scores ({len(tier1_keys)} tier1, "
        f"{len(tier2_keys)} tier2, {len(tier3_candidates)} tier3) to {scores_path}",
        file=sys.stderr,
    )

    if unmatched:
        print(
            f"\n{len(unmatched)} models had no leaderboard match and no score:",
            file=sys.stderr,
        )
        for alias in unmatched:
            print(f"  - {alias}", file=sys.stderr)


if __name__ == "__main__":
    main()
