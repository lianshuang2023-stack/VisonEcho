import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LandingImpact from './LandingImpact';
import { UiPreferencesContext } from '../uiPreferences';
import type { UiLanguage } from '../uiPreferences';

afterEach(cleanup);
function view(language: UiLanguage) { return <UiPreferencesContext.Provider value={{ language, theme: 'light', setLanguage: vi.fn(), setTheme: vi.fn(), t: (zh, en) => language === 'en' ? en : zh }}><div className="ve-landing"><LandingImpact /></div></UiPreferencesContext.Provider>; }

describe('landing audience value', () => {
  it('switches one scenario at a time with accessible selected states and concrete deliverables', () => {
    render(view('en'));
    const controls = screen.getByRole('group', { name: 'Choose a use case' });
    expect(within(controls).getByRole('button', { name: 'Creators' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(within(controls).getByRole('button', { name: 'Education' }));
    expect(within(controls).getByRole('button', { name: 'Education' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(controls).getByRole('button', { name: 'Creators' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('heading', { name: 'Make the lesson available beyond the picture.' })).toBeVisible();
    expect(screen.getByText('Review script')).toBeVisible();
    expect(screen.getByText('Explore institutional pilots for accessible course libraries.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Give an existing story another way to be followed.' })).not.toBeInTheDocument();
  });

  it('keeps the chosen use case when the page language changes', () => {
    const rendered = render(view('en'));
    fireEvent.click(screen.getByRole('button', { name: 'Content teams' }));
    rendered.rerender(view('zh-CN'));
    expect(screen.getByRole('button', { name: '内容制作团队' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: '把无障碍版本，纳入日常制作。' })).toBeVisible();
    expect(screen.getByText('人物卡')).toBeVisible();
    expect(screen.getByText('可探索按项目交付的口述影像制作服务。')).toBeVisible();
  });
});
