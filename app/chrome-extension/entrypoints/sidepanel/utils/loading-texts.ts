/**
 * Random loading messages
 * Used by the TimelineStatusStep component to show playful waiting prompts
 */

const loadingTexts = [
  // Classics
  'This was supposed to be smooth and effortless',
  'Now it is a frantic scramble',
  'I know you are in a hurry, but hold on',
  'Doggy-paddling through the ocean of knowledge',
  'Letting the bullets fly a little longer',
  'Hand-crafting your answer',
  'Rallying the little goblins',
  'Stop rushing, it is already being written (new folder)',
  'Thinking so hard I am breaking a sweat',
  'My CPU is about to catch fire',
  // Everyday vibes
  'Slow-roasting at the village cafe, good things take time',
  'Flipping the knowledge pancake',
  'Toasting to myself, almost ready',
  'Putting inspiration in the oven',
  'Letting the answer steep a little longer',
  'Maxing out the emotional support',
  'Knitting you a sweater of words',
  // Wild imagination
  'Neurons hitting the dance floor',
  'A night-owl is deep in thought',
  'Coloring in the answer',
  'Frantically flipping through the knowledge base',
  'The brain circus is starting',
  'Squishing zeros and ones together',
  'Charging up a big move',
  'My magnifying glass fogged up, wiping it',
  'Trying to make sense of this wild request',
  // Fantasy
  'Casting a spell, do not disturb',
  'Waking up my silicon friend',
  'Connecting to the wisdom of cyberspace',
  'Hold on, friend, I am working it out',
  'Passing through the knowledge black hole',
  'Reverse-engineering human intent',
  'The crystal ball is hazy, giving it a tap',
  // Work mode
  'Code running faster than a reporter',
  'The host is online, please wait',
  'Galloping over as fast as I can',
  'Hauling knowledge at light speed',
  'The last piece of the puzzle',
  'The answer is about to wrap',
  'Launch countdown',
  'Locking on to the target',
];

/**
 * Get a random loading message
 */
export function getRandomLoadingText(): string {
  return loadingTexts[Math.floor(Math.random() * loadingTexts.length)];
}
