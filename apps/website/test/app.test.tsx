// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/web/App';

const config = { mcpUrl: 'https://api-dev.example/mcp', connectorName: 'AI App Hosting (dev)' };
const loadConfig = () => Promise.resolve(config);

describe('homepage flow (WEB-1)', () => {
  beforeEach(() => {
    window.location.hash = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => {}) }, configurable: true });
  });
  afterEach(cleanup);

  it('only lets Claude be chosen (WEB-1.2)', async () => {
    render(<App loadConfig={loadConfig} />);
    expect((screen.getByRole('button', { name: /ChatGPT/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Gemini/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Coming soon')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    expect(screen.getByRole('heading', { name: 'Connect Claude to us' })).toBeTruthy();
  });

  it('shows the Claude steps with screenshots and copyable connector details (WEB-1.3)', async () => {
    render(<App loadConfig={loadConfig} />);
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    const settings = screen.getByAltText('Claude menu with Settings highlighted');
    expect(settings.getAttribute('width')).toBe('263');
    expect(screen.getByAltText(/Connectors highlighted/).getAttribute('height')).toBe('799');
    await waitFor(() => expect(screen.getByText(config.mcpUrl)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(config.mcpUrl);
    await userEvent.click(screen.getByRole('button', { name: 'Copy name' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('AI App Hosting (dev)');
  });

  it('requires a description, defaults to "only me", and builds the prompt (WEB-1.4–1.6)', async () => {
    render(<App loadConfig={loadConfig} />);
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    await userEvent.click(screen.getByRole('button', { name: "Done, it's connected" }));
    const create = screen.getByRole('button', { name: 'Create my prompt' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('radio', { name: 'Only me' }) as HTMLInputElement).checked).toBe(true);

    await userEvent.type(screen.getByLabelText('Your app'), 'A recipe box for my family');
    await userEvent.click(screen.getByRole('radio', { name: 'Several people' }));
    await userEvent.click(create);

    const prompt = screen.getByTestId('prompt').textContent ?? '';
    expect(prompt).toContain('A recipe box for my family');
    expect(prompt).toContain('Several people.');
    expect(prompt).toContain('"AI App Hosting (dev)" connector');
    await userEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(prompt);
    expect(screen.getByRole('link', { name: /Open Claude/ }).getAttribute('href')).toBe('https://claude.ai/new');
  });

  it('limits the description length', async () => {
    render(<App loadConfig={loadConfig} />);
    window.location.hash = '/describe';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    const textarea = await screen.findByLabelText('Your app');
    await userEvent.click(textarea);
    await userEvent.paste('x'.repeat(2001));
    expect(screen.getByText(/keep it under 2000 characters/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create my prompt' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('goes back step by step and starts over', async () => {
    render(<App loadConfig={loadConfig} />);
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: /Build your own app/ })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    await userEvent.click(screen.getByRole('button', { name: "Done, it's connected" }));
    await userEvent.type(screen.getByLabelText('Your app'), 'Habit tracker');
    await userEvent.click(screen.getByRole('button', { name: 'Create my prompt' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start over' }));
    expect(screen.getByRole('heading', { name: /Build your own app/ })).toBeTruthy();
  });

  it('never sends the description anywhere (WEB-1.7)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(<App loadConfig={loadConfig} />);
    await userEvent.click(screen.getByRole('button', { name: /^Claude/ }));
    await userEvent.click(screen.getByRole('button', { name: "Done, it's connected" }));
    await userEvent.type(screen.getByLabelText('Your app'), 'secret idea');
    await userEvent.click(screen.getByRole('button', { name: 'Create my prompt' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
