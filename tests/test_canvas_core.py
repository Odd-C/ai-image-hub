import json
import subprocess
from pathlib import Path

CORE_PATH = Path(__file__).parents[1] / "src/image_hub/static/canvas-core.js"


def run_canvas_core(script: str) -> dict:
    completed = subprocess.run(
        ["node", "-e", script],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(completed.stdout)


def test_new_request_chooses_first_enabled_profile_and_never_falls_back_for_history():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        const profiles = [
          {{id:'libtv:a', enabled:false}},
          {{id:'lovart:b', enabled:true}},
          {{id:'api:c', enabled:true}}
        ];
        console.log(JSON.stringify({{
          selected: core.chooseRequestProfile(profiles, '')?.id || null,
          none: core.chooseRequestProfile(profiles.map(p => ({{...p, enabled:false}})), ''),
          missingHistorical: core.chooseRequestProfile(profiles, 'api:removed'),
          unavailable: core.requestAvailability(null),
          available: core.requestAvailability(profiles[1])
        }}));
        """
    )

    assert result["selected"] == "lovart:b"
    assert result["none"] is None
    assert result["missingHistorical"] is None
    assert result["available"] == {"enabled": True, "message": ""}
    assert result["unavailable"]["enabled"] is False
    assert "不可用" in result["unavailable"]["message"]


def test_history_locate_deduplicates_and_continue_copies_the_full_request():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        let sequence = 0;
        const uid = prefix => `${{prefix}}-${{++sequence}}`;
        const nodes = [];
        const item = {{
          id:'generation-old', prompt:'historical prompt', provider:'api',
          model_label:'Legacy model', profile_id:'api:opaque', profile_available:true,
          parameters:{{ratio:'3:4', resolution:'4K', quality:'standard'}},
          parent_generation_id:'earlier-parent', status:'succeeded',
          artifact_url:'/artifact', sentiment:'satisfied', can_retry:false
        }};
        const first = core.historyAction(nodes, item, 'locate', uid);
        const second = core.historyAction(nodes, item, 'locate', uid);
        const continued = core.historyAction(nodes, item, 'continue', uid);
        console.log(JSON.stringify({{
          nodeCount:nodes.length,
          sameResult:first.result.id === second.result.id,
          locateRequest:first.request,
          focusId:second.focusId,
          request:continued.request
        }}));
        """
    )

    assert result["nodeCount"] == 1
    assert result["sameResult"] is True
    assert result["locateRequest"] is None
    assert result["focusId"] == "result-1"
    assert result["request"] == {
        "prompt": "historical prompt",
        "profileId": "api:opaque",
        "ratio": "3:4",
        "resolution": "4K",
        "quality": "standard",
        "inputId": "result-1",
        "parentGenerationId": "generation-old",
    }


def test_restored_local_upload_requires_reselection_without_changing_relationships():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        const restored = core.restoreCanvasNodes([
          {{id:'upload-1', type:'image', x:42, y:73, src:'blob:old', localOnly:true}},
          {{id:'request-1', type:'generation_request', orderedInputIds:['upload-1']}}
        ]);
        const missing = core.firstMissingLocalInput(restored, restored[1], () => false);
        console.log(JSON.stringify({{restored, missingId:missing?.id || null}}));
        """
    )

    restored = result["restored"]
    assert restored[0]["x"] == 42
    assert restored[0]["y"] == 73
    assert restored[0]["src"] == ""
    assert restored[0]["needsReselect"] is True
    assert restored[1]["orderedInputIds"] == ["upload-1"]
    assert result["missingId"] == "upload-1"


def test_copy_paste_remaps_internal_relationships_without_backend_evidence():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        let sequence = 0;
        const uid = prefix => `${{prefix}}-new-${{++sequence}}`;
        const nodes = [
          {{id:'image-a', type:'image', x:10, y:20, width:200}},
          {{id:'request-a', type:'generation_request', x:250, y:20, width:340,
            orderedInputIds:['image-a','missing'], submitting:true}},
          {{id:'result-a', type:'generation_result', generationId:'immutable-generation',
            requestId:'request-a', x:650, y:20, width:240, sentiment:'adopted', canRetry:true}}
        ];
        const copied = core.clonePresentationNodes(nodes, nodes.map(n => n.id), uid, {{x:36,y:40}});
        console.log(JSON.stringify(copied));
        """
    )
    clones = {node["type"]: node for node in result["clones"]}
    assert clones["image"]["x"] == 46
    assert clones["generation_request"]["orderedInputIds"] == [clones["image"]["id"]]
    assert clones["generation_request"]["submitting"] is False
    assert clones["generation_result"]["requestId"] == clones["generation_request"]["id"]
    assert clones["generation_result"]["presentationProxy"] is True
    assert "generationId" not in clones["generation_result"]
    assert "sentiment" not in clones["generation_result"]
    assert "canRetry" not in clones["generation_result"]


def test_delete_is_presentation_only_and_prunes_references():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        const nodes = [
          {{id:'image-a', type:'image'}},
          {{id:'request-a', type:'generation_request', orderedInputIds:['image-a']}},
          {{id:'result-a', type:'generation_result', generationId:'keep-in-database', requestId:'request-a'}}
        ];
        console.log(JSON.stringify(core.removePresentationNodes(nodes, ['image-a','request-a'])));
        """
    )
    assert result == [{
        "id": "result-a",
        "type": "generation_result",
        "generationId": "keep-in-database",
        "requestId": "",
    }]


def test_geometry_converts_screen_centers_once_and_builds_minimap():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        const port = core.rectCenterToWorld(
          {{left:510,top:305,width:12,height:12}},
          {{left:100,top:50,width:800,height:600}},
          {{x:80,y:35,zoom:1.5}}
        );
        const visible = core.visibleWorld({{width:800,height:600}}, {{x:80,y:35,zoom:1.5}});
        const mini = core.minimapGeometry([{{x:10,y:20,width:200,height:100}}], visible);
        const center = core.minimapPointToWorld({{
          x:mini.viewport.x + mini.viewport.width/2,
          y:mini.viewport.y + mini.viewport.height/2
        }}, mini);
        console.log(JSON.stringify({{port,visible,mini,center}}));
        """
    )
    assert result["port"] == {"x": 224, "y": 150.66666666666666}
    assert result["visible"]["x"] == -53.333333333333336
    assert result["visible"]["width"] == 533.3333333333334
    assert len(result["mini"]["nodes"]) == 1
    assert abs(result["center"]["x"] - (result["visible"]["x"] + result["visible"]["width"] / 2)) < 1e-9
    assert abs(result["center"]["y"] - (result["visible"]["y"] + result["visible"]["height"] / 2)) < 1e-9


def test_editable_targets_disable_canvas_shortcuts():
    result = run_canvas_core(
        f"""
        const core = require({json.dumps(str(CORE_PATH))});
        console.log(JSON.stringify({{
          input: core.isEditableTarget({{tagName:'INPUT'}}),
          canvas: core.isEditableTarget({{tagName:'SECTION', isContentEditable:false}}),
          editable: core.isEditableTarget({{tagName:'DIV', isContentEditable:true}})
        }}));
        """
    )
    assert result == {"input": True, "canvas": False, "editable": True}
