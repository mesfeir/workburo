/**
 * What the words attached to a picture are asking for.
 *
 * Attaching a picture used to mean one of two things, chosen with a switch in the composer: change it
 * at fal, or let the chat model look at it. That switch was wrong twice over. It defaulted to
 * editing, so a dropped screenshot with a question about it went to fal to be redrawn. And it asked
 * the user to make a decision they had already made in words.
 *
 * So the words decide. Change-words mean edit; question-words mean look; a continuation ("again",
 * "more", "same but") follows whatever the last turn was. What is left over is a case the app cannot
 * answer for the user, and it says so instead of guessing -- because guessing wrong either spends fal
 * credits or sends a picture to a text model that never looks at it.
 */
export type ImageIntent = 'edit' | 'look' | 'unsure'

/* Verbs that ask for the picture itself to change. */
const EDIT =
  /\b(make|change|edit|turn|convert|transform|remove|delete|erase|add|put|place|replace|swap|recolour|recolor|colour|color|paint|style|restyle|upscale|enlarge|resize|scale|crop|rotate|flip|mirror|blur|sharpen|brighten|darken|adjust|fix|clean|redo|reimagine|animate|redraw|extend|zoom|retouch|remove the background|cut out)\b/i

/* Words that ask about the picture: what it is, what it says, what is in it. */
const LOOK =
  /\b(what|whats|which|who|whose|where|when|why|how|describe|explain|read|tell|summarise|summarize|translate|extract|identify|recognise|recognize|compare|difference|differences|see|shown|says|say|contains|means|is|are|does|do|can|could|any)\b/i

/* Asking for more of whatever just happened. */
const CONTINUE = /\b(again|more|another|same|keep|carry on|continue|now|also|then|next|still|instead)\b/i

export function readImageIntent(text: string, lastWasEdit: boolean): ImageIntent {
  const t = (text || '').trim()
  /* A picture on its own is something to look at, never something to paint over. This default is the
     point of the whole rule: nothing is spent and nothing is redrawn unless the words asked. */
  if (!t) return 'look'

  const edit = EDIT.test(t)
  const look = LOOK.test(t)
  if (edit && !look) return 'edit'
  if (look && !edit) return 'look'
  /* Asked for both at once ("remove the caption and tell me what it said") -- one turn can only do
     one, so the app asks which came first. */
  if (edit && look) return 'unsure'
  if (CONTINUE.test(t)) return lastWasEdit ? 'edit' : 'look'
  return 'unsure'
}
