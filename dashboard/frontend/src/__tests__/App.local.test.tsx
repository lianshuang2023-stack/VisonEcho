import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import App from '../App';

const mocks = vi.hoisted(() => ({ local: true, loadAuthConfig: vi.fn(), getSession: vi.fn(), signOut: vi.fn() }));
vi.mock('../config', () => ({ get IS_LOCAL_BACKEND() { return mocks.local; } }));
vi.mock('../auth', () => mocks);
vi.mock('../components/LoginPage', () => ({ default: () => <div>Cognito login</div> }));
vi.mock('../components/LocalVideoWorkspace', () => ({ default: () => <div>视频项目工作区</div> }));
vi.mock('../components/ViewerPage', () => ({ default: () => <div>Viewer page</div> }));
vi.mock('../components/CostPage', () => ({ default: () => <div>AWS cost estimate</div> }));
vi.mock('../components/TriggerPage', () => ({ default: () => <div>AWS process page</div> }));
beforeEach(() => { mocks.local = true; mocks.getSession.mockResolvedValue(null); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
describe('dashboard entry points', () => {
  it('opens the local video workspace without touching Cognito or mounting AWS pages', () => {
    render(<App />);
    expect(screen.getByText('视频项目工作区')).toBeVisible();
    expect(mocks.loadAuthConfig).not.toHaveBeenCalled();
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(screen.queryByText('AWS process page')).toBeNull();
    expect(screen.queryByText('AWS cost estimate')).toBeNull();
  });
  it('retains the AWS login gate when local mode is off', async () => {
    mocks.local = false;
    render(<App />);
    expect(await screen.findByText('Cognito login')).toBeVisible();
    expect(mocks.loadAuthConfig).toHaveBeenCalledOnce();
    expect(mocks.getSession).toHaveBeenCalledOnce();
    expect(screen.queryByText('视频项目工作区')).toBeNull();
  });
});
