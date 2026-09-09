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
