import {
    App
} from 'aws-cdk-lib';

import { Template, Match } from "aws-cdk-lib/assertions";

import {
    MainStack
} from '../src/molecule-unfolding/cdk/stack-main';

describe("Listener", () => {
    test("has 1 Events Rule", () => {
        const app = new App();
        const stack = new MainStack(app, 'test');
        const template = Template.fromStack(stack);
        template.resourceCountIs("AWS::Events::Rule", 1)
    })

    test("Events Rule is configed correctly", () => {
        const app = new App();
        const stack = new MainStack(app, 'test');
        const template = Template.fromStack(stack);
        template.hasResourceProperties("AWS::Events::Rule", {
            EventPattern: Match.objectLike({
                "source": [
                    "aws.braket"
                  ],
                "detail-type": [
                    "Braket Task State Change"
                ]
            })
        })
    })
})