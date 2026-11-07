package com.example.sample;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/sample")
public class SampleController {

    @GetMapping("/{id}")
    public SampleDto getSample(@PathVariable("id") Long id) {
        return new SampleDto();
    }

    @PostMapping
    public SampleDto createSample(@RequestBody CreateSampleRequest request) {
        return new SampleDto();
    }

    @GetMapping("/generic")
    public GenericContainer<SampleDto> getGeneric() {
        return new GenericContainer<>();
    }
}
