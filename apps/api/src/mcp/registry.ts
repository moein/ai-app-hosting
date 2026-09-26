import { getPlatformGuide } from '../tools/platform-guide';
import type { AnyTool } from './tool';

/** Every tool the server exposes. Features add their tools here as they land (catalog: spec 04 design). */
export const TOOLS: AnyTool[] = [getPlatformGuide];
