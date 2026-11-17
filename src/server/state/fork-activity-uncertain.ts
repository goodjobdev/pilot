/** An admitted activity may still be running; its owning fork fence must remain held. */
export class ForkActivityUncertain extends Error {
 constructor(){super('The provider activity could not be confirmed stopped; operator review is required.');}
}
