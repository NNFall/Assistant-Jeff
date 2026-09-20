// The model selects typed operations; native code owns every Windows argument.
export function createAgentSystemTools({systemTools}={}) {
  const tool=(name,title,description,intent,properties={})=>({name,title,description,effect:name!=='system_volume_get',
    parameters:{type:'object',properties,required:Object.keys(properties),additionalProperties:false},
    execute:(args,{signal}={})=>systemTools.executeSystemTool(intent(args),{signal})});
  return [
    tool('system_volume_get','Узнать громкость','Read the actual default Windows playback device volume and mute state.',()=>({kind:'get_system_volume'})),
    tool('system_volume_set','Установить громкость','Set the default Windows playback volume to percent (0..100), then verify the device and value. This does not unmute.',args=>({kind:'volume',percent:args.percent}),{percent:{type:'number',minimum:0,maximum:100}}),
    tool('assistant_minimize','Свернуть Jeff','Minimize only the Assistant Jeff window when the user asks to hide/minimize the assistant.',()=>({kind:'self_minimize'})),
  ];
}
