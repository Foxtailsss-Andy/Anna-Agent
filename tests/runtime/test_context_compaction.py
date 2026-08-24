from services.runtime.app.context_compaction import (
    AUTOCOMPACT_BUFFER_TOKENS,
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
    MODEL_CONTEXT_WINDOW_DEFAULT,
    PROTECTED_TAIL_MESSAGES,
    TRUNCATED_TOOL_RESULT_PLACEHOLDER,
    compact_messages,
    estimate_tokens,
    get_auto_compact_threshold,
    get_context_window_for_model,
    get_effective_context_window_size,
)


def test_context_window_defaults_and_overrides_are_model_agnostic():
    assert get_context_window_for_model("mimo-v2.5-pro") == MODEL_CONTEXT_WINDOW_DEFAULT
    # Explicit runtime-config override wins.
    assert get_context_window_for_model("mimo-v2.5-pro", override=120_000) == 120_000
    # The reference's [1m] opt-in marker is preserved (and case-insensitive).
    assert get_context_window_for_model("some-model[1m]") == 1_000_000
    assert get_context_window_for_model("some-model[1M]") == 1_000_000
    # A non-positive override is ignored and falls back to default.
    assert get_context_window_for_model("mimo-v2.5-pro", override=0) == MODEL_CONTEXT_WINDOW_DEFAULT


def test_threshold_math_matches_reference_buffers():
    window = 200_000
    assert get_effective_context_window_size(window) == window - MAX_OUTPUT_TOKENS_FOR_SUMMARY
    assert (
        get_auto_compact_threshold(window)
        == window - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS
    )


def test_estimate_tokens_grows_with_content_and_counts_cjk_denser():
    short = [{"role": "user", "content": "hi"}]
    long = [{"role": "user", "content": "word " * 1000}]
    assert estimate_tokens(long) > estimate_tokens(short)
    # CJK is estimated denser (~1 token/char) than ASCII (~4 chars/token).
    ascii_msg = [{"role": "user", "content": "a" * 100}]
    cjk_msg = [{"role": "user", "content": "中" * 100}]
    assert estimate_tokens(cjk_msg) > estimate_tokens(ascii_msg)


def test_compact_messages_is_noop_under_threshold():
    messages = [
        {"role": "user", "content": "本月收入是多少"},
        {"role": "assistant", "content": "正在查询"},
    ]
    result = compact_messages(messages, model="mimo-v2.5-pro")
    assert result.compacted is False
    assert result.messages == messages
    assert result.tokens_freed == 0


def test_compact_messages_is_noop_when_disabled():
    big = "x" * 1_000_000
    messages = [{"role": "tool", "tool_call_id": "c1", "content": big}]
    result = compact_messages(messages, model="mimo-v2.5-pro", enabled=False)
    assert result.compacted is False
    assert result.messages[0]["content"] == big


def test_compact_messages_truncates_old_tool_results_over_threshold():
    # Force a tiny window so the threshold is low: 34k window -> effective 14k ->
    # threshold 1k tokens.
    window = 34_000
    assert get_auto_compact_threshold(window) == 1_000

    big_tool_result = "x" * 40_000  # ~10k tokens of ASCII on its own
    messages = [
        {"role": "user", "content": "请分析逾期应收"},
        {"role": "assistant", "tool_calls": [{"id": "c1", "function": {"name": "q"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": big_tool_result},
        # Enough recent tail (>= PROTECTED_TAIL_MESSAGES) so the bulky tool result
        # above sits in the unprotected head and is eligible for truncation.
        {"role": "assistant", "content": "已拿到数据"},
        {"role": "user", "content": "继续 1"},
        {"role": "assistant", "content": "ok 1"},
        {"role": "user", "content": "继续 2"},
        {"role": "assistant", "content": "ok 2"},
        {"role": "user", "content": "继续 3"},
    ]
    original_snapshot = [dict(message) for message in messages]

    result = compact_messages(messages, model="mimo-v2.5-pro", context_window=window)

    assert result.compacted is True
    assert result.post_compact_token_count < result.pre_compact_token_count
    assert result.tokens_freed > 0
    # The bulky old tool result was truncated...
    assert result.messages[2]["content"] == TRUNCATED_TOOL_RESULT_PLACEHOLDER
    # ...but its tool_call_id linkage is preserved (structure intact).
    assert result.messages[2]["tool_call_id"] == "c1"
    # The assistant/tool_calls envelope is untouched.
    assert result.messages[1]["tool_calls"][0]["id"] == "c1"
    # The input messages were never mutated (cache-safety rule).
    assert messages == original_snapshot


def test_compact_messages_protects_recent_tail():
    window = 34_000
    big = "x" * 40_000
    # A recent tool result inside the protected tail must NOT be truncated.
    tail_filler = [{"role": "assistant", "content": "ok"} for _ in range(PROTECTED_TAIL_MESSAGES - 1)]
    messages = [{"role": "tool", "tool_call_id": "recent", "content": big}, *tail_filler]

    result = compact_messages(messages, model="mimo-v2.5-pro", context_window=window)

    # The only tool result sits in the protected tail, so nothing is truncated.
    assert result.messages[0]["content"] == big


def test_context_usage_snapshot_is_model_agnostic():
    from services.runtime.app.context_compaction import context_usage

    messages = [{"role": "user", "content": "本月收入是多少"}]
    usage = context_usage(messages, model="mimo-v2.5-pro")
    assert usage["context_window"] == MODEL_CONTEXT_WINDOW_DEFAULT
    assert usage["token_count"] == estimate_tokens(messages)
    assert 0 <= usage["percent_left"] <= 100
    assert usage["is_above_auto_compact_threshold"] is False

    # A tiny window pushes usage past the auto-compact threshold.
    heavy = [{"role": "tool", "tool_call_id": "c1", "content": "x" * 40_000}]
    hot = context_usage(heavy, model="mimo-v2.5-pro", context_window=34_000)
    assert hot["is_above_auto_compact_threshold"] is True
    assert hot["percent_left"] == 0


# --- L4a autocompact_messages (the pure LLM-summary orchestration) -------------

_AUTOCOMPACT_WINDOW = 34_000  # -> threshold 1_000 tokens
_ANCHOR = "锚点A47"
# A distinct marker planted in a MIDDLE message that the summarizer never echoes,
# so its absence after compaction proves the original middle was dropped (not just
# re-summarized alongside a surviving copy — an append-only regression the before>
# after token proxy can miss in the small-window regime).
_MIDDLE_MARKER = "中段独有标记M13"


def _long_conversation() -> list[dict]:
    # system head + a big early middle (carries the anchor + the middle marker) + a
    # recent tail.
    bulk = "对话内容" * 400
    return [
        {"role": "system", "content": "系统提示"},
        {"role": "user", "content": f"最早的问题 {_ANCHOR} {bulk}"},
        {"role": "assistant", "content": f"最早的回答 {_MIDDLE_MARKER} {bulk}"},
        {"role": "user", "content": "第二个问题"},
        {"role": "assistant", "content": "第二个回答"},
        {"role": "user", "content": "第三个问题"},
        {"role": "assistant", "content": "第三个回答"},
        {"role": "user", "content": "第四个问题"},
        {"role": "assistant", "content": "第四个回答"},
        {"role": "user", "content": "现在请总结"},
    ]


def test_autocompact_below_threshold_is_a_noop():
    from services.runtime.app.context_compaction import (
        FRESH_AUTOCOMPACT_TRACKING,
        autocompact_messages,
    )

    messages = [{"role": "user", "content": "简短提问"}]
    called = []
    out, info, state = autocompact_messages(
        messages,
        summarize=lambda text: called.append(text) or "摘要",
        state=FRESH_AUTOCOMPACT_TRACKING,
        window=_AUTOCOMPACT_WINDOW,
    )
    assert info is None
    assert out == messages
    assert called == []  # never spends a model call under threshold
    assert state is FRESH_AUTOCOMPACT_TRACKING


def test_autocompact_summarizes_middle_into_one_summary_message():
    from services.runtime.app.context_compaction import (
        CONVERSATION_SUMMARY_OPEN,
        FRESH_AUTOCOMPACT_TRACKING,
        _split_head_middle_tail,
        autocompact_messages,
        estimate_tokens,
        is_conversation_summary_message,
    )

    messages = _long_conversation()
    original = [dict(message) for message in messages]

    def summarize(segment_text: str) -> str:
        # The middle (with the anchor) reaches the summarizer; echo the fact.
        assert _ANCHOR in segment_text
        return f"早期要点保留 {_ANCHOR}。以上任务中已完成的部分不要重新执行。"

    out, info, state = autocompact_messages(
        messages,
        summarize=summarize,
        state=FRESH_AUTOCOMPACT_TRACKING,
        window=_AUTOCOMPACT_WINDOW,
    )

    assert info is not None
    assert info.before_tokens > info.after_tokens  # tokens dropped
    assert estimate_tokens(out) == info.after_tokens
    # System head preserved; exactly one summary message; recent tail intact.
    assert out[0] == {"role": "system", "content": "系统提示"}
    summaries = [m for m in out if is_conversation_summary_message(m)]
    assert len(summaries) == 1
    assert CONVERSATION_SUMMARY_OPEN in summaries[0]["content"]
    assert _ANCHOR in summaries[0]["content"]
    assert out[-1] == {"role": "user", "content": "现在请总结"}
    # Middle-absence invariant (L4a follow-up): the rebuilt list is exactly
    # head + one summary + tail, and NO original middle message survives — a
    # direct check, not the indirect before>after token proxy.
    head, middle, tail = _split_head_middle_tail(messages)
    assert any(_MIDDLE_MARKER in str(m.get("content", "")) for m in middle)  # planted in middle
    assert len(out) == len(head) + 1 + len(tail)
    # The unique middle marker is gone from EVERY post-compaction message (checked
    # by scanning all contents, not just fixed positions).
    assert not any(_MIDDLE_MARKER in str(m.get("content", "")) for m in out)
    # Tracking reset on success; inputs never mutated (cache-safety rule).
    assert state.compacted is True
    assert state.consecutive_failures == 0
    assert messages == original


def test_autocompact_breaker_stops_after_max_consecutive_failures():
    from services.runtime.app.context_compaction import (
        FRESH_AUTOCOMPACT_TRACKING,
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        autocompact_messages,
    )

    calls = {"n": 0}

    def raising_summarize(_segment_text: str):
        calls["n"] += 1
        raise RuntimeError("summary model unavailable")

    state = FRESH_AUTOCOMPACT_TRACKING
    # Each attempt over threshold fails and increments the breaker.
    for _ in range(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES):
        out, info, state = autocompact_messages(
            _long_conversation(),
            summarize=raising_summarize,
            state=state,
            window=_AUTOCOMPACT_WINDOW,
        )
        assert info is None  # a raise never crashes and never compacts
    assert calls["n"] == MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    assert state.consecutive_failures == MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES

    # The next attempt is short-circuited by the breaker — summarize NOT called.
    out, info, state = autocompact_messages(
        _long_conversation(),
        summarize=raising_summarize,
        state=state,
        window=_AUTOCOMPACT_WINDOW,
    )
    assert info is None
    assert calls["n"] == MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES  # no further attempts


def test_autocompact_recompaction_yields_a_single_summary():
    from services.runtime.app.context_compaction import (
        FRESH_AUTOCOMPACT_TRACKING,
        autocompact_messages,
        is_conversation_summary_message,
    )

    def summarize(_segment_text: str) -> str:
        return "合并摘要。以上任务中已完成的部分不要重新执行。"

    first, info1, state = autocompact_messages(
        _long_conversation(),
        summarize=summarize,
        state=FRESH_AUTOCOMPACT_TRACKING,
        window=_AUTOCOMPACT_WINDOW,
    )
    assert info1 is not None

    # Grow the conversation well past threshold again so the PRIOR summary sits in
    # the middle; the next pass must fold it into ONE summary, never stack a second.
    grown = [*first, *[{"role": "user", "content": "又一个大问题 " + "内容" * 1000}]]
    second, info2, _ = autocompact_messages(
        grown,
        summarize=summarize,
        state=state,
        window=_AUTOCOMPACT_WINDOW,
    )
    assert info2 is not None
    summaries = [m for m in second if is_conversation_summary_message(m)]
    assert len(summaries) == 1  # single-summary invariant across recompaction
