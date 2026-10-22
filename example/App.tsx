import type { ReactElement } from 'react';
import { Button } from 'react-native';
import { AssistantButton, ScreenContextProvider, useAssistant } from '../src';
import { backendModel } from './model';
import { deviceVoice } from './voice-adapters';

const assistant = {
  greeting: 'Hi! How can I help?',
  voice: deviceVoice({ locale: 'en-US' }),
  model: backendModel({ endpoint: 'https://api.example.com/screen-agent/turn' }),
};

// Speech-to-speech instead: pass { greeting, realtime: myRealtimeModel } (see RealtimeVoiceModel).

export default function App() {
  return (
    <ScreenContextProvider assistant={assistant} glow={{ thickness: 3, cornerRadius: 44 }}>
      <YourNavigation />
      <AssistantButton />
    </ScreenContextProvider>
  );
}

// Or trigger it from any button of your own:
function HelpButton() {
  const { state, toggle } = useAssistant();
  return <Button title={state === 'idle' ? 'Ask' : 'Stop'} onPress={toggle} />;
}

declare function YourNavigation(): ReactElement;
export { HelpButton };
