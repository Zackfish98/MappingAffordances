The interactive is pulling scripting from five different elements that I've built:
- export_fields.py- It is where the shortest walk calculation is occuring from pre calibration to post
- export_stages.py- defines what each stage of the interactive is doing. This is mostly assembling previous computations that I had built individually
- export_access_table.py​- Pulls the table from the statistics progression


These then have a series of animations that I itereated with an LLM to develop. Those are: 
- timeline.js- a clock function that triggers when what happens
- field.js- works out walkshed coverage from each individual park walking time data
- spread.js- determines how the walkshed looks as its moving
- reveal.js- the animation cycle for parks revealing their color and pulses
- zoom.js- enables full resolution of the call out pannel

The workflow of the build thus far has been testing in a notebook with a sample of Brooklyn, once the elements, features and aestics are to the point that I like it working with an LLM becomes a workflow that is a lot more understood in structure and design.
That being said-I try to intentionally keep the aestic development of an interactive as bare bones as possible when working with an LLM to avoid situations when stylistic decisions could be assumed and carried out by the LLM.