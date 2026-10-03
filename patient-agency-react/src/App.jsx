import { useState } from 'react';
import { useStore } from './state/store.jsx';
import { BottomNav, Toast } from './components/ui.jsx';
import SidePanel from './components/SidePanel.jsx';
import Connect from './screens/Connect.jsx';
import Today from './screens/Today.jsx';
import Journey from './screens/Journey.jsx';
import Progress from './screens/Progress.jsx';
import MyData from './screens/MyData.jsx';
import VisitPrep from './screens/VisitPrep.jsx';
import VoiceAgent from './components/VoiceAgent.jsx';
import ClinicalTrials from './screens/ClinicalTrials.jsx';

const SCREENS = { today: Today, journey: Journey, progress: Progress, data: MyData, visit: VisitPrep, trials: ClinicalTrials };

export default function App() {
  const { state } = useStore();
  const [tab, setTab] = useState('today');
  const connected = !!state.ctx;
  const Screen = SCREENS[tab];

  const go = t => {
    setTab(t);
    document.querySelector('.screen')?.scrollTo({ top: 0 });
  };

  return (
    <div className="wrap">
      <div className="phone">
        <div className="statusbar"><span>9:41</span><span>●●● 5G ▮</span></div>
        <main className="screen">
          {connected ? <Screen go={go} /> : <Connect />}
        </main>
        <Toast />
        {connected && <VoiceAgent />}
        {connected && <BottomNav tab={tab} onChange={go} />}
      </div>
      <SidePanel tab={connected ? tab : 'connect'} />
    </div>
  );
}
