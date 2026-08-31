from services.crew.app.command_drafting import DRAFT_TOOL
from services.crew.app.decomposition import EMIT_TOOL as DECOMPOSITION_EMIT_TOOL
from services.crew.app.matching import EMIT_TOOL as MATCHING_EMIT_TOOL


def test_crew_emit_tools_are_explicit_replay_safe_proposals():
    for tool in (DECOMPOSITION_EMIT_TOOL, MATCHING_EMIT_TOOL, DRAFT_TOOL):
        assert tool["effect"] == "proposal"
        assert tool["replay_policy"] == "safe"
