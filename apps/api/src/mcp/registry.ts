import { logout } from '../tools/auth/logout';
import { requestLoginCode } from '../tools/auth/request-login-code';
import { verifyLoginCode } from '../tools/auth/verify-login-code';
import { whoami } from '../tools/auth/whoami';
import { getPlatformGuide } from '../tools/platform-guide';
import type { AnyTool } from './tool';

/** Every tool the server exposes. Features add their tools here as they land (catalog: spec 04 design). */
export const TOOLS: AnyTool[] = [getPlatformGuide, requestLoginCode, verifyLoginCode, whoami, logout];
