// Leaves room for body base64, JSON metadata, GCM tag and the outer envelope.
export const MAX_BRIDGE_RESPONSE_BYTES=240*1024;
export const MAX_CONTROL_BYTES=64*1024;
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
/** Keep actionable controls whole. Oversized terminal output retains its newest text. */
export function boundedOutput(input){
  const result={...input};
  const controls={agentModelMenu:result.agentModelMenu,codexModelMenu:result.codexModelMenu,question:result.question};
  if(bytes(controls)>MAX_CONTROL_BYTES){delete result.agentModelMenu;delete result.codexModelMenu;delete result.question;result.controlsTruncated=true;}
  if(bytes(result)<=MAX_BRIDGE_RESPONSE_BYTES)return result;
  const text=typeof result.text==='string'?result.text:'';result.truncated=true;
  let low=0,high=text.length;
  while(low<high){const mid=Math.ceil((low+high)/2);result.text=text.slice(-mid);if(bytes(result)<=MAX_BRIDGE_RESPONSE_BYTES)low=mid;else high=mid-1;}
  result.text=low?text.slice(-low):'';
  if(result.text.length&&/[\uDC00-\uDFFF]/.test(result.text[0]))result.text=result.text.slice(1);
  return result;
}
