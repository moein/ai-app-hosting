import { checkSlug } from '../tools/apps/check-slug';
import { createApp } from '../tools/apps/create-app';
import { deleteApp } from '../tools/apps/delete-app';
import { getApp } from '../tools/apps/get-app';
import { getUsage } from '../tools/apps/get-usage';
import { listApps } from '../tools/apps/list-apps';
import { retryProvisioning } from '../tools/apps/retry-provisioning';
import { logout } from '../tools/auth/logout';
import { requestLoginCode } from '../tools/auth/request-login-code';
import { verifyLoginCode } from '../tools/auth/verify-login-code';
import { whoami } from '../tools/auth/whoami';
import { getDeployment } from '../tools/deployments/get-deployment';
import { listDeployments } from '../tools/deployments/list-deployments';
import { redeploy } from '../tools/deployments/redeploy';
import { rollback } from '../tools/deployments/rollback';
import { listFiles } from '../tools/files/list-files';
import { readFile } from '../tools/files/read-file';
import { writeFiles } from '../tools/files/write-files';
import { getPlatformGuide } from '../tools/platform-guide';
import type { AnyTool } from './tool';

/** Every tool the server exposes. Features add their tools here as they land (catalog: spec 04 design). */
export const TOOLS: AnyTool[] = [
  getPlatformGuide,
  requestLoginCode,
  verifyLoginCode,
  whoami,
  logout,
  getUsage,
  checkSlug,
  createApp,
  retryProvisioning,
  listApps,
  getApp,
  deleteApp,
  listFiles,
  readFile,
  writeFiles,
  listDeployments,
  getDeployment,
  redeploy,
  rollback,
];
