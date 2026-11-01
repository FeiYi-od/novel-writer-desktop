import './provider-badge.css';
import { identifyProvider, type ProviderIdentity } from '../../core/provider-identity';

const names: Record<ProviderIdentity, string> = { openai: 'OpenAI', gemini: 'Gemini', deepseek: 'DeepSeek', qwen: '通义千问', claude: 'Claude', ollama: 'Ollama 本机', custom: '自定义接口' };

/** Original abstract markers; these are not provider logos. */
export function ProviderBadge({ baseUrl, adapter }: { baseUrl: string; adapter?: string }) {
  const provider = identifyProvider(baseUrl, adapter);
  return <span className={`provider-badge provider-${provider}`} title={`按接口地址识别：${names[provider]}（原创图形，非官方标识）`} aria-hidden="true"><svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" focusable="false">
    {provider === 'openai' && <><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /><path d="M12 7v10" /></>}
    {provider === 'gemini' && <path d="M12 3c.8 4.8 3.2 7.2 8 8-4.8.8-7.2 3.2-8 8-.8-4.8-3.2-7.2-8-8 4.8-.8 7.2-3.2 8-8Z" />}
    {provider === 'deepseek' && <><path d="M3 12c3-4 5-4 9 0s6 4 9 0" /><path d="M4 16c2-2 4-2 7 0s5 2 9-1" /><path d="M15 6h4" /></>}
    {provider === 'qwen' && <><ellipse cx="12" cy="12" rx="8" ry="4" transform="rotate(-35 12 12)" /><ellipse cx="12" cy="12" rx="8" ry="4" transform="rotate(35 12 12)" /><circle cx="12" cy="12" r="1" /></>}
    {provider === 'claude' && <><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.7 5.7l2.1 2.1m8.4 8.4 2.1 2.1m0-12.6-2.1 2.1m-8.4 8.4-2.1 2.1" /></>}
    {provider === 'ollama' && <><path d="M5 18c0-7 3-11 9-12 1 6-2 11-9 12Zm0 0c2-4 5-6 8-8" /><circle cx="18" cy="16" r="2" /></>}
    {provider === 'custom' && <><path d="M12 4c.7 4 2.3 5.7 6 6.5-3.7.7-5.3 2.5-6 6.5-.7-4-2.3-5.8-6-6.5C9.7 9.7 11.3 8 12 4Z" /><path d="M18 17v3m-1.5-1.5h3" /></>}
  </svg></span>;
}
