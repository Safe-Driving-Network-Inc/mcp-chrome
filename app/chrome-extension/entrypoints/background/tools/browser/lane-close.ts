// Kareenos Browser Channel — `lane_close` action → kareenos_lane_close (read-class).
//
// The platform sends it when the run that drove a lane lets go of the Cloud
// Browser (cloud_browser_close, run end, lease expiry): the lane's tab and the
// popups it opened are closed and its refs forgotten, so tabs never pile up
// across runs (2026-10-21). Never closes the browser's last tab (it is parked
// on about:blank instead) and never touches tabs of other lanes.
import { BaseBrowserToolExecutor, closeLane } from '../base-browser';
import type { ToolResult } from '@/common/tool-handler';
import { structuredErrorFromException } from '@/common/browser-errors';
import { KAREENOS_TOOL_NAMES } from '@/common/kareenos-tool-names';

export interface LaneCloseParams {
  reason?: string;
  laneId?: string;
  timeoutMs?: number;
}

class LaneCloseTool extends BaseBrowserToolExecutor {
  name = KAREENOS_TOOL_NAMES.LANE_CLOSE;

  async execute(args: LaneCloseParams): Promise<ToolResult> {
    const laneId = args.laneId || 'default';
    try {
      const r = await closeLane(laneId);
      console.log(
        `[BC] lane_close ${laneId} tab=${r.tab} popups=${r.popups_closed} reason=${args.reason || '-'}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Lane ${laneId} closed`,
              ...r,
              reason: args.reason || null,
            }),
          },
        ],
        isError: false,
      };
    } catch (e) {
      return structuredErrorFromException(e);
    }
  }
}

export const laneCloseTool = new LaneCloseTool();
