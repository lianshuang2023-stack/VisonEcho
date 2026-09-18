import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LandingTimingDemo from './LandingTimingDemo';
import { UiPreferencesContext } from '../uiPreferences';

afterEach(cleanup);
const setup = () => render(<UiPreferencesContext.Provider value={{ language:'en', theme:'light', setLanguage:vi.fn(), setTheme:vi.fn(), t:(_zh,en)=>en }}><LandingTimingDemo /></UiPreferencesContext.Provider>);

describe('landing narration timing illustration', () => {
  it('keeps natural-gap source and output clocks aligned while activity follows the slider', () => {
    setup();
    const slider = screen.getByRole('slider', { name:'Explore narration timing' });
    expect(screen.getByRole('button', { name:'In dialogue gaps' })).toHaveAttribute('aria-pressed','true');
    expect(slider).toHaveAttribute('max','10');
    expect(slider).toHaveValue('4');
    expect(screen.getByTestId('timing-output-time')).toHaveTextContent('4.0 s');
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('4.0 s');
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Narration fills the dialogue gap'));
    fireEvent.change(slider,{target:{value:'8.2'}});
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('8.2 s');
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Original dialogue plays'));
    expect(screen.getByText('Timing illustration, not a real video')).toBeVisible();
  });

  it('holds source time during an extended description and resumes after the pause', () => {
    setup();
    fireEvent.click(screen.getByRole('button',{name:'With pauses'}));
    const slider = screen.getByRole('slider',{name:'Explore narration timing'});
    expect(screen.getByRole('button',{name:'With pauses'})).toHaveAttribute('aria-pressed','true');
    expect(slider).toHaveAttribute('max','14');
    expect(slider).toHaveValue('6');
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('5.0 s');
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Picture held at 5 seconds'));
    fireEvent.change(slider,{target:{value:'8.9'}});
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('5.0 s');
    fireEvent.change(slider,{target:{value:'9'}});
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Picture continues with the original sound'));
    fireEvent.change(slider,{target:{value:'11.4'}});
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('7.4 s');
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('Original dialogue plays'));
    fireEvent.change(slider,{target:{value:'14'}});
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('10.0 s');
    expect(slider).toHaveAttribute('aria-valuetext',expect.stringContaining('End of example'));
    fireEvent.click(screen.getByRole('button',{name:'In dialogue gaps'}));
    expect(slider).toHaveValue('4');
    expect(screen.getByTestId('timing-source-time')).toHaveTextContent('4.0 s');
  });
});
