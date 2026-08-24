from services.crew.app.sop_templates import get_template, list_templates


def test_two_templates_available():
    ids = {t.id for t in list_templates()}
    assert ids == {"feature_iteration", "marketing_collateral"}


def test_feature_iteration_has_review_gate_for_prd():
    template = get_template("feature_iteration")
    keys = [t.key for t in template.tasks]
    assert "prd" in keys and "prd_review" in keys
    prd_review = next(t for t in template.tasks if t.key == "prd_review")
    assert prd_review.is_gate is True
    assert prd_review.reviews == "prd"
    assert "prd" in prd_review.depends_on


def test_every_dependency_and_review_target_is_a_known_key():
    for template in list_templates():
        keys = {t.key for t in template.tasks}
        for task in template.tasks:
            for dep in task.depends_on:
                assert dep in keys, f"{template.id}:{task.key} dep {dep} unknown"
            if task.reviews is not None:
                assert task.reviews in keys


def test_feature_iteration_has_parallel_design_and_tech_research():
    """R-B #4:PRD 评审后分叉出「设计稿 ∥ 技术预研」并行段,设计评审是双父门。"""
    template = get_template("feature_iteration")
    assert template is not None
    keys = [t.key for t in template.tasks]
    # 9 节点、3 门(新增技术预研 producer)。
    assert len(template.tasks) == 9
    assert sum(1 for t in template.tasks if t.is_gate) == 3
    assert "tech_research" in keys

    by_key = {t.key: t for t in template.tasks}
    # 并行分叉:设计稿与技术预研都依赖 PRD 评审通过。
    assert by_key["design"].depends_on == ["prd_review"]
    assert by_key["tech_research"].depends_on == ["prd_review"]
    assert by_key["tech_research"].role_required == "工程"
    # 双父汇合:设计评审依赖设计稿 + 技术预研两者,评审对象=设计稿。
    assert set(by_key["design_review"].depends_on) == {"design", "tech_research"}
    assert by_key["design_review"].is_gate and by_key["design_review"].reviews == "design"


def test_get_unknown_template_returns_none():
    assert get_template("nope") is None
