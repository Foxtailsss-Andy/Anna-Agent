import pytest

from services.runtime.app.hiker_tool_registry import HIKER_ALLOWED_TOOLS, HikerToolRegistry


def test_model_visible_tools_lists_all_allowed():
    tools = HikerToolRegistry().model_visible_tools()
    names = {tool["name"] for tool in tools}
    assert names == set(HIKER_ALLOWED_TOOLS)
    for tool in tools:
        assert tool["input_schema"]["type"] == "object"
        assert tool["description"]
        assert tool["schema_source"] == "registry"


def test_assert_allowed_accepts_read_tool():
    HikerToolRegistry().assert_allowed("hiker.contract.list_contracts")


def test_assert_allowed_rejects_write_tool():
    with pytest.raises(PermissionError):
        HikerToolRegistry().assert_allowed("hiker.update_record")


def test_model_visible_tools_respects_skill_allow_and_forbidden():
    class _Skill:
        allowed_tools = [
            "hiker.contract.list_contracts",
            "hiker.contract.get_business_chain",
            "hiker.report.get_dashboard_summary",
        ]
        forbidden_tools = ["hiker.contract.get_business_chain"]

    tools = HikerToolRegistry().model_visible_tools(_Skill())
    names = {tool["name"] for tool in tools}
    assert names == {"hiker.contract.list_contracts", "hiker.report.get_dashboard_summary"}
