import { json } from '@sveltejs/kit';
import { Base64 } from 'js-base64';
import { callOpenRouter } from '$lib/server/ai';

/** @type {import('./$types').RequestHandler} */
export async function POST({ request, locals, platform }) {
    if (!locals.user) {
        return json({ error: 'Unauthorized' }, { status: 401 });
    }

    const formData = await request.formData();
    const audioFile = formData.get('audio');
    if (!audioFile) throw new Error('No audio provided');

    // Convert Blob/File to Base64
    const arrayBuffer = await audioFile.arrayBuffer();
    const base64Audio = Base64.fromUint8Array(new Uint8Array(arrayBuffer));

    // Prompt Gemini to transcribe
    const messages = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Please transcribe this audio exactly as spoken. Do not add any commentary.' },
                {
                    type: 'input_audio',
                    input_audio: {
                        data: base64Audio,
                        format: 'wav'
                    }
                }
            ]
        }
    ];

    const data = await callOpenRouter(platform.env, messages);
    const transcript = data.choices[0]?.message?.content || "";

    return json({ text: transcript });
}
